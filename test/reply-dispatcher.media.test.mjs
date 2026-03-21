import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const fromRoot = (relativePath) =>
  pathToFileURL(path.join(rootDir, relativePath)).href;

const distDir = 'dist/src';
const rawModulePath = path.join(rootDir, `${distDir}/card/reply-dispatcher.js`);
const testableModulePath = path.join(rootDir, 'test/.tmp/reply-dispatcher.testable.mjs');
fs.mkdirSync(path.dirname(testableModulePath), { recursive: true });
fs.writeFileSync(
  testableModulePath,
  fs
    .readFileSync(rawModulePath, 'utf8')
    .replaceAll("'../core/accounts'", `'${fromRoot(`${distDir}/core/accounts.js`)}'`)
    .replaceAll("'../core/footer-config'", `'${fromRoot(`${distDir}/core/footer-config.js`)}'`)
    .replaceAll("'../core/lark-client'", `'${fromRoot(`${distDir}/core/lark-client.js`)}'`)
    .replaceAll("'../core/lark-logger'", `'${fromRoot(`${distDir}/core/lark-logger.js`)}'`)
    .replaceAll("'../messaging/outbound/send'", `'${fromRoot(`${distDir}/messaging/outbound/send.js`)}'`)
    .replaceAll("'../messaging/outbound/typing'", `'${fromRoot(`${distDir}/messaging/outbound/typing.js`)}'`)
    .replaceAll("'./reply-mode'", `'${fromRoot(`${distDir}/card/reply-mode.js`)}'`)
    .replaceAll("'./streaming-card-controller'", `'${fromRoot(`${distDir}/card/streaming-card-controller.js`)}'`)
    .replaceAll("'./unavailable-guard'", `'${fromRoot(`${distDir}/card/unavailable-guard.js`)}'`)
    .replaceAll("'../messaging/outbound/deliver'", `'${fromRoot(`${distDir}/messaging/outbound/deliver.js`)}'`),
  'utf8',
);
const moduleUnderTest = pathToFileURL(testableModulePath).href;

async function setup(t, options = {}) {
  const sentText = [];
  const sentCards = [];
  const sentMedia = [];
  const terminateCalls = [];

  const sendMediaImpl = options.sendMediaImpl ?? (async (payload) => {
    sentMedia.push(payload);
  });

  t.mock.module('openclaw/plugin-sdk', {
    namedExports: {
      createReplyPrefixContext: () => ({
        responsePrefix: '',
        responsePrefixContextProvider: () => null,
        onModelSelected: () => {},
      }),
      createTypingCallbacks: () => ({
        onReplyStart: async () => {},
        onIdle: async () => {},
        onCleanup: async () => {},
      }),
      logTypingFailure: () => {},
    },
  });

  t.mock.module(fromRoot(`${distDir}/core/accounts.js`), {
    namedExports: {
      getLarkAccount: () => ({ config: {} }),
    },
  });

  t.mock.module(fromRoot(`${distDir}/core/footer-config.js`), {
    namedExports: {
      resolveFooterConfig: () => null,
    },
  });

  t.mock.module(fromRoot(`${distDir}/core/lark-client.js`), {
    namedExports: {
      LarkClient: {
        runtime: {
          channel: {
            text: {
              resolveTextChunkLimit: () => 4000,
              resolveChunkMode: () => 'paragraph',
              resolveMarkdownTableMode: () => 'plain',
              convertMarkdownTables: (text) => text,
              chunkTextWithMode: (text) => (text ? [text] : []),
            },
            reply: {
              createReplyDispatcherWithTyping: (hooks) => ({
                dispatcher: {
                  deliver: hooks.deliver,
                  onError: hooks.onError,
                },
                replyOptions: {},
                markDispatchIdle: () => {},
              }),
              resolveHumanDelayConfig: () => null,
            },
          },
        },
      },
    },
  });

  t.mock.module(fromRoot(`${distDir}/core/lark-logger.js`), {
    namedExports: {
      larkLogger: () => ({
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }),
    },
  });

  t.mock.module(fromRoot(`${distDir}/messaging/outbound/send.js`), {
    namedExports: {
      sendMessageFeishu: async (payload) => {
        sentText.push(payload);
      },
      sendMarkdownCardFeishu: async (payload) => {
        sentCards.push(payload);
      },
    },
  });

  t.mock.module(fromRoot(`${distDir}/messaging/outbound/typing.js`), {
    namedExports: {
      addTypingIndicator: async () => null,
      removeTypingIndicator: async () => {},
    },
  });

  t.mock.module(fromRoot(`${distDir}/card/reply-mode.js`), {
    namedExports: {
      resolveReplyMode: () => 'static',
      expandAutoMode: ({ mode }) => mode,
      shouldUseCard: options.shouldUseCard ?? (() => false),
    },
  });

  t.mock.module(fromRoot(`${distDir}/card/streaming-card-controller.js`), {
    namedExports: {
      StreamingCardController: class {},
    },
  });

  t.mock.module(fromRoot(`${distDir}/card/unavailable-guard.js`), {
    namedExports: {
      UnavailableGuard: class {
        shouldSkip() {
          return false;
        }
        terminate(source, err) {
          terminateCalls.push({ source, err });
          return options.terminateReturn ?? true;
        }
        get isTerminated() {
          return false;
        }
      },
    },
  });

  t.mock.module(fromRoot(`${distDir}/messaging/outbound/deliver.js`), {
    namedExports: {
      sendMediaLark: async (payload) => {
        await sendMediaImpl(payload);
      },
    },
  });

  const { createFeishuReplyDispatcher } = await import(
    `${moduleUnderTest}?case=${encodeURIComponent(t.name)}-${Date.now()}-${Math.random()}`
  );

  const result = createFeishuReplyDispatcher({
    cfg: {},
    agentId: 'agent-test',
    chatId: 'chat-test',
    replyToMessageId: 'om_reply',
    accountId: 'default',
    replyInThread: false,
    chatType: 'p2p',
    skipTyping: true,
  });

  return {
    dispatcher: result.dispatcher,
    sentText,
    sentCards,
    sentMedia,
    terminateCalls,
  };
}

test('media-only payload does not send empty text message', async (t) => {
  const ctx = await setup(t);

  await ctx.dispatcher.deliver({
    text: '',
    mediaUrl: 'https://example.com/image.png',
  });

  assert.equal(ctx.sentText.length, 0);
  assert.equal(ctx.sentCards.length, 0);
  assert.equal(ctx.sentMedia.length, 1);
  assert.equal(ctx.sentMedia[0].mediaUrl, 'https://example.com/image.png');
});

test('mixed payload delivers both text and media', async (t) => {
  const ctx = await setup(t);

  await ctx.dispatcher.deliver({
    text: 'hello from feishu',
    mediaUrls: [
      'https://example.com/image-a.png',
      'https://example.com/image-b.png',
    ],
  });

  assert.equal(ctx.sentText.length, 1);
  assert.equal(ctx.sentText[0].text, 'hello from feishu');
  assert.deepEqual(
    ctx.sentMedia.map((item) => item.mediaUrl),
    [
      'https://example.com/image-a.png',
      'https://example.com/image-b.png',
    ],
  );
});

test('failed media send triggers staticGuard terminate', async (t) => {
  const mediaError = new Error('bot removed from chat');
  const ctx = await setup(t, {
    sendMediaImpl: async () => {
      throw mediaError;
    },
    terminateReturn: true,
  });

  await ctx.dispatcher.deliver({
    text: '',
    mediaUrl: 'https://example.com/image.png',
  });

  assert.equal(ctx.terminateCalls.length, 1);
  assert.equal(ctx.terminateCalls[0].source, 'deliver.media');
  assert.equal(ctx.terminateCalls[0].err, mediaError);
});

test('terminate on first media aborts remaining media URLs', async (t) => {
  let sendCount = 0;
  const mediaError = new Error('bot removed from chat');
  const ctx = await setup(t, {
    sendMediaImpl: async () => {
      sendCount++;
      if (sendCount === 1) throw mediaError;
    },
    terminateReturn: true,
  });

  await ctx.dispatcher.deliver({
    text: '',
    mediaUrls: [
      'https://example.com/a.png',
      'https://example.com/b.png',
      'https://example.com/c.png',
    ],
  });

  assert.equal(sendCount, 1, 'only the first media URL should be attempted');
  assert.equal(ctx.terminateCalls.length, 1);
  assert.equal(ctx.sentMedia.length, 0, 'no media should succeed');
});

test('non-terminal media error logs and continues to next URL', async (t) => {
  let sendCount = 0;
  const mediaError = new Error('transient upload failure');
  const ctx = await setup(t, {
    sendMediaImpl: async (payload) => {
      sendCount++;
      if (sendCount === 1) throw mediaError;
      ctx.sentMedia.push(payload);
    },
    terminateReturn: false,
  });

  await ctx.dispatcher.deliver({
    text: '',
    mediaUrls: [
      'https://example.com/a.png',
      'https://example.com/b.png',
    ],
  });

  assert.equal(sendCount, 2, 'both media URLs should be attempted');
  assert.equal(ctx.terminateCalls.length, 1, 'terminate called once for the failure');
  assert.equal(ctx.sentMedia.length, 1, 'second media should succeed');
  assert.equal(ctx.sentMedia[0].mediaUrl, 'https://example.com/b.png');
});
