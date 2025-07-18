/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  streamText,
  type StreamTextOnFinishCallback,
  createDataStreamResponse,
  generateText,
  appendResponseMessages,
} from 'ai';
import {
  getCurrentDateContext,
  GmailSearchAssistantSystemPrompt,
  AiChatPrompt,
} from '../lib/prompts';
import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import { EPrompts, type IOutgoingMessage, type ParsedMessage } from '../types';
import type { IGetThreadResponse, MailManager } from '../lib/driver/types';
import { connectionToDriver, getZeroAgent } from '../lib/server-utils';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Connection, type WSMessage } from 'agents';
import { ToolOrchestrator } from './agent/orchestrator';
import type { CreateDraftData } from '../lib/schemas';
import { withRetry } from '../lib/gmail-rate-limit';
import { env, RpcTarget } from 'cloudflare:workers';
import { AIChatAgent } from 'agents/ai-chat-agent';
import { tools as authTools } from './agent/tools';
import { processToolCalls } from './agent/utils';
import type { Message as ChatMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { getPromptName } from '../pipelines';
import { connection } from '../db/schema';
import { getPrompt } from '../lib/brain';
import { FOLDERS } from '../lib/utils';
import { and, eq } from 'drizzle-orm';
import { McpAgent } from 'agents/mcp';
import { createDb } from '../db';
import { Effect } from 'effect';
import { z } from 'zod';

const decoder = new TextDecoder();

export enum IncomingMessageType {
  UseChatRequest = 'cf_agent_use_chat_request',
  ChatClear = 'cf_agent_chat_clear',
  ChatMessages = 'cf_agent_chat_messages',
  ChatRequestCancel = 'cf_agent_chat_request_cancel',
  Mail_List = 'zero_mail_list_threads',
  Mail_Get = 'zero_mail_get_thread',
}

export enum OutgoingMessageType {
  ChatMessages = 'cf_agent_chat_messages',
  UseChatResponse = 'cf_agent_use_chat_response',
  ChatClear = 'cf_agent_chat_clear',
  Mail_List = 'zero_mail_list_threads',
  Mail_Get = 'zero_mail_get_thread',
}

export type IncomingMessage =
  | {
      type: IncomingMessageType.UseChatRequest;
      id: string;
      init: Pick<RequestInit, 'method' | 'headers' | 'body'>;
    }
  | {
      type: IncomingMessageType.ChatClear;
    }
  | {
      type: IncomingMessageType.ChatMessages;
      messages: ChatMessage[];
    }
  | {
      type: IncomingMessageType.ChatRequestCancel;
      id: string;
    }
  | {
      type: IncomingMessageType.Mail_List;
      folder: string;
      query: string;
      maxResults: number;
      labelIds: string[];
      pageToken: string;
    }
  | {
      type: IncomingMessageType.Mail_Get;
      threadId: string;
    };

export type OutgoingMessage =
  | {
      type: OutgoingMessageType.ChatMessages;
      messages: ChatMessage[];
    }
  | {
      type: OutgoingMessageType.UseChatResponse;
      id: string;
      body: string;
      done: boolean;
    }
  | {
      type: OutgoingMessageType.ChatClear;
    }
  | {
      type: OutgoingMessageType.Mail_List;
      folder: string;
    }
  | {
      type: OutgoingMessageType.Mail_Get;
      threadId: string;
    };

export class AgentRpcDO extends RpcTarget {
  constructor(
    private mainDo: ZeroAgent,
    private connectionId: string,
  ) {
    super();
  }

  async getUserLabels() {
    return await this.mainDo.getUserLabels();
  }

  async getLabel(id: string) {
    return await this.mainDo.getLabel(id);
  }

  async createLabel(label: {
    name: string;
    color?: { backgroundColor: string; textColor: string };
  }) {
    return await this.mainDo.createLabel(label);
  }

  async updateLabel(
    id: string,
    label: { name: string; color?: { backgroundColor: string; textColor: string } },
  ) {
    return await this.mainDo.updateLabel(id, label);
  }

  async deleteLabel(id: string) {
    return await this.mainDo.deleteLabel(id);
  }

  async bulkDelete(threadIds: string[]) {
    return await this.mainDo.bulkDelete(threadIds);
  }

  async bulkArchive(threadIds: string[]) {
    return await this.mainDo.bulkArchive(threadIds);
  }

  async rawListThreads(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    return await this.mainDo.rawListThreads(params);
  }

  async listThreads(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    return await this.mainDo.list(params);
  }

  async getThread(threadId: string) {
    return await this.mainDo.get(threadId);
  }

  async markThreadsRead(threadIds: string[]) {
    const result = await this.mainDo.markThreadsRead(threadIds);
    await Promise.all(threadIds.map((id) => this.mainDo.syncThread(id)));
    return result;
  }

  async syncThread(threadId: string) {
    return await this.mainDo.syncThread(threadId);
  }

  async markThreadsUnread(threadIds: string[]) {
    const result = await this.mainDo.markThreadsUnread(threadIds);
    await Promise.all(threadIds.map((id) => this.mainDo.syncThread(id)));
    return result;
  }

  async modifyLabels(threadIds: string[], addLabelIds: string[], removeLabelIds: string[]) {
    const result = await this.mainDo.modifyLabels(threadIds, addLabelIds, removeLabelIds);
    await Promise.all(threadIds.map((id) => this.mainDo.syncThread(id)));
    return result;
  }

  async createDraft(draftData: CreateDraftData) {
    return await this.mainDo.createDraft(draftData);
  }

  async getDraft(id: string) {
    return await this.mainDo.getDraft(id);
  }

  async listDrafts(params: { q?: string; maxResults?: number; pageToken?: string }) {
    return await this.mainDo.listDrafts(params);
  }

  async count() {
    return await this.mainDo.count();
  }

  //   async list(params: {
  //     folder: string;
  //     query?: string;
  //     maxResults?: number;
  //     labelIds?: string[];
  //     pageToken?: string;
  //   }) {
  //     return await this.mainDo.list(params);
  //   }

  async markAsRead(threadIds: string[]) {
    const result = await this.mainDo.markAsRead(threadIds);
    await Promise.all(threadIds.map((id) => this.mainDo.syncThread(id)));
    return result;
  }

  async markAsUnread(threadIds: string[]) {
    const result = await this.mainDo.markAsUnread(threadIds);
    await Promise.all(threadIds.map((id) => this.mainDo.syncThread(id)));
    return result;
  }

  async normalizeIds(ids: string[]) {
    return await this.mainDo.normalizeIds(ids);
  }

  //   async get(id: string) {
  //     return await this.mainDo.get(id);
  //   }

  async sendDraft(id: string, data: IOutgoingMessage) {
    return await this.mainDo.sendDraft(id, data);
  }

  async create(data: IOutgoingMessage) {
    return await this.mainDo.create(data);
  }

  async delete(id: string) {
    return await this.mainDo.delete(id);
  }

  async deleteAllSpam() {
    return await this.mainDo.deleteAllSpam();
  }

  async getEmailAliases() {
    return await this.mainDo.getEmailAliases();
  }

  async setupAuth(connectionId: string) {
    return await this.mainDo.setupAuth(connectionId);
  }

  async broadcast(message: string) {
    return this.mainDo.broadcast(message);
  }

  //   async getThreadsFromDB(params: {
  //     labelIds?: string[];
  //     folder?: string;
  //     q?: string;
  //     max?: number;
  //     cursor?: string;
  //   }) {
  //     return await this.mainDo.getThreadsFromDB(params);
  //   }

  //   async getThreadFromDB(id: string) {
  //     return await this.mainDo.getThreadFromDB(id);
  //   }

  async listHistory<T>(historyId: string) {
    return await this.mainDo.listHistory<T>(historyId);
  }

  async syncThreads(folder: string) {
    return await this.mainDo.syncThreads(folder);
  }

  async inboxRag(query: string) {
    return await this.mainDo.inboxRag(query);
  }

  async searchThreads(params: {
    query: string;
    folder?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    return await this.mainDo.searchThreads(params);
  }
}

const shouldDropTables = env.DROP_AGENT_TABLES === 'true';
const maxCount = parseInt(env.THREAD_SYNC_MAX_COUNT || '40', 10);
const shouldLoop = env.THREAD_SYNC_LOOP !== 'false';

export class ZeroAgent extends AIChatAgent<typeof env> {
  private chatMessageAbortControllers: Map<string, AbortController> = new Map();
  private foldersInSync: Map<string, boolean> = new Map();
  private syncThreadsInProgress: Map<string, boolean> = new Map();
  private currentFolder: string | null = 'inbox';
  driver: MailManager | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (shouldDropTables) this.dropTables();
    this.sql`
        CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            thread_id TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            latest_sender TEXT,
            latest_received_on TEXT,
            latest_subject TEXT,
            latest_label_ids TEXT,
            categories TEXT
        );
    `;
  }

  async dropTables() {
    return this.sql`       
        DROP TABLE IF EXISTS threads;`;
  }

  async setMetaData(connectionId: string) {
    await this.setName(connectionId);
    return new AgentRpcDO(this, connectionId);
  }

  async registerZeroMCP() {
    await this.mcp.connect(env.VITE_PUBLIC_BACKEND_URL + '/sse', {
      transport: {
        authProvider: new DurableObjectOAuthClientProvider(
          this.ctx.storage,
          'zero-mcp',
          env.VITE_PUBLIC_BACKEND_URL,
        ),
      },
    });
  }

  onStart(): void | Promise<void> {
    // this.registerZeroMCP();
  }

  private getDataStreamResponse(
    onFinish: StreamTextOnFinishCallback<{}>,
    _?: {
      abortSignal: AbortSignal | undefined;
    },
  ) {
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        const connectionId = this.name;
        if (connectionId === 'general') return;
        if (!connectionId || !this.driver) {
          console.log('Unauthorized no driver or connectionId [1]', connectionId, this.driver);
          await this.setupAuth(connectionId);
          if (!connectionId || !this.driver) {
            console.log('Unauthorized no driver or connectionId', connectionId, this.driver);
            throw new Error('Unauthorized no driver or connectionId [2]');
          }
        }
        const orchestrator = new ToolOrchestrator(dataStream, connectionId);
        // const mcpTools = await this.mcp.unstable_getAITools();

        const rawTools = {
          ...(await authTools(this, connectionId)),
        };
        const tools = orchestrator.processTools({});
        const processedMessages = await processToolCalls(
          {
            messages: this.messages,
            dataStream,
            tools,
          },
          {},
        );

        const result = streamText({
          model: anthropic(env.OPENAI_MODEL || 'claude-3-5-haiku-latest'),
          maxSteps: 10,
          messages: processedMessages,
          tools: rawTools,
          onFinish,
          onError: (error) => {
            console.error('Error in streamText', error);
          },
          system: await getPrompt(getPromptName(connectionId, EPrompts.Chat), AiChatPrompt('')),
        });

        result.mergeIntoDataStream(dataStream);
      },
    });

    return dataStreamResponse;
  }

  public async setupAuth(connectionId: string) {
    if (connectionId === 'general') return;
    if (!this.driver) {
      const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
      const _connection = await db.query.connection.findFirst({
        where: eq(connection.id, connectionId),
      });
      if (_connection) this.driver = connectionToDriver(_connection);
      this.ctx.waitUntil(conn.end());
      this.ctx.waitUntil(this.syncThreads('inbox'));
      this.ctx.waitUntil(this.syncThreads('sent'));
      this.ctx.waitUntil(this.syncThreads('spam'));
      this.ctx.waitUntil(this.syncThreads('archive'));
    }
  }

  private async tryCatchChat<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
    }
  }

  private getAbortSignal(id: string): AbortSignal | undefined {
    // Defensive check, since we're coercing message types at the moment
    if (typeof id !== 'string') {
      return undefined;
    }

    if (!this.chatMessageAbortControllers.has(id)) {
      this.chatMessageAbortControllers.set(id, new AbortController());
    }

    return this.chatMessageAbortControllers.get(id)?.signal;
  }

  /**
   * Remove an abort controller from the cache of pending message responses
   */
  private removeAbortController(id: string) {
    this.chatMessageAbortControllers.delete(id);
  }

  private broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  private cancelChatRequest(id: string) {
    if (this.chatMessageAbortControllers.has(id)) {
      const abortController = this.chatMessageAbortControllers.get(id);
      abortController?.abort();
    }
  }

  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message === 'string') {
      let data: IncomingMessage;
      try {
        data = JSON.parse(message) as IncomingMessage;
      } catch (error) {
        console.warn(error);
        // silently ignore invalid messages for now
        // TODO: log errors with log levels
        return;
      }
      switch (data.type) {
        case IncomingMessageType.UseChatRequest: {
          if (data.init.method !== 'POST') break;

          const { body } = data.init;

          const { messages } = JSON.parse(body as string);
          this.broadcastChatMessage(
            {
              type: OutgoingMessageType.ChatMessages,
              messages,
            },
            [connection.id],
          );
          await this.persistMessages(messages, [connection.id]);

          const chatMessageId = data.id;
          const abortSignal = this.getAbortSignal(chatMessageId);

          return this.tryCatchChat(async () => {
            const response = await this.onChatMessage(
              async ({ response }) => {
                const finalMessages = appendResponseMessages({
                  messages,
                  responseMessages: response.messages,
                });

                await this.persistMessages(finalMessages, [connection.id]);
                this.removeAbortController(chatMessageId);
              },
              abortSignal ? { abortSignal } : undefined,
            );

            if (response) {
              await this.reply(data.id, response);
            } else {
              console.warn(
                `[AIChatAgent] onChatMessage returned no response for chatMessageId: ${chatMessageId}`,
              );
              this.broadcastChatMessage(
                {
                  id: data.id,
                  type: OutgoingMessageType.UseChatResponse,
                  body: 'No response was generated by the agent.',
                  done: true,
                },
                [connection.id],
              );
            }
          });
        }
        case IncomingMessageType.ChatClear: {
          this.destroyAbortControllers();
          this.sql`delete from cf_ai_chat_agent_messages`;
          this.messages = [];
          this.broadcastChatMessage(
            {
              type: OutgoingMessageType.ChatClear,
            },
            [connection.id],
          );
          break;
        }
        case IncomingMessageType.ChatMessages: {
          await this.persistMessages(data.messages, [connection.id]);
          break;
        }
        case IncomingMessageType.ChatRequestCancel: {
          this.cancelChatRequest(data.id);
          break;
        }
        // case IncomingMessageType.Mail_List: {
        //   const result = await this.getThreadsFromDB({
        //     labelIds: data.labelIds,
        //     folder: data.folder,
        //     q: data.query,
        //     max: data.maxResults,
        //     cursor: data.pageToken,
        //   });
        //   this.currentFolder = data.folder;
        //   connection.send(
        //     JSON.stringify({
        //       type: OutgoingMessageType.Mail_List,
        //       result,
        //     }),
        //   );
        //   break;
        // }
        // case IncomingMessageType.Mail_Get: {
        //   const result = await this.getThreadFromDB(data.threadId);
        //   connection.send(
        //     JSON.stringify({
        //       type: OutgoingMessageType.Mail_Get,
        //       result,
        //       threadId: data.threadId,
        //     }),
        //   );
        //   break;
        // }
      }
    }
  }

  private async reply(id: string, response: Response) {
    // now take chunks out from dataStreamResponse and send them to the client
    return this.tryCatchChat(async () => {
      for await (const chunk of response.body!) {
        const body = decoder.decode(chunk);

        this.broadcastChatMessage({
          id,
          type: OutgoingMessageType.UseChatResponse,
          body,
          done: false,
        });
      }

      this.broadcastChatMessage({
        id,
        type: OutgoingMessageType.UseChatResponse,
        body: '',
        done: true,
      });
    });
  }

  async onConnect() {
    await this.setupAuth(this.name);
  }

  private destroyAbortControllers() {
    for (const controller of this.chatMessageAbortControllers.values()) {
      controller?.abort();
    }
    this.chatMessageAbortControllers.clear();
  }

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<{}>,
    options?: {
      abortSignal: AbortSignal | undefined;
    },
  ) {
    return this.getDataStreamResponse(onFinish, options);
  }

  async listThreads(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.getThreadsFromDB(params);
  }

  async rawListThreads(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.list(params);
  }

  async getThread(threadId: string) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.getThreadFromDB(threadId);
  }

  async markThreadsRead(threadIds: string[]) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.modifyLabels(threadIds, {
      addLabels: [],
      removeLabels: ['UNREAD'],
    });
  }

  async markThreadsUnread(threadIds: string[]) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.modifyLabels(threadIds, {
      addLabels: ['UNREAD'],
      removeLabels: [],
    });
  }

  async modifyLabels(threadIds: string[], addLabelIds: string[], removeLabelIds: string[]) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.modifyLabels(threadIds, {
      addLabels: addLabelIds,
      removeLabels: removeLabelIds,
    });
  }

  async listHistory<T>(historyId: string) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.listHistory<T>(historyId);
  }

  async getUserLabels() {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.getUserLabels();
  }

  async getLabel(id: string) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.getLabel(id);
  }

  async createLabel(params: {
    name: string;
    color?: {
      backgroundColor: string;
      textColor: string;
    };
  }) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.createLabel(params);
  }

  async bulkDelete(threadIds: string[]) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.modifyLabels(threadIds, {
      addLabels: ['TRASH'],
      removeLabels: ['INBOX'],
    });
  }

  async bulkArchive(threadIds: string[]) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.modifyLabels(threadIds, {
      addLabels: [],
      removeLabels: ['INBOX'],
    });
  }

  async updateLabel(
    id: string,
    label: { name: string; color?: { backgroundColor: string; textColor: string } },
  ) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.updateLabel(id, label);
  }

  async deleteLabel(id: string) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.deleteLabel(id);
  }

  async createDraft(draftData: CreateDraftData) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.createDraft(draftData);
  }

  async getDraft(id: string) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.getDraft(id);
  }

  async listDrafts(params: { q?: string; maxResults?: number; pageToken?: string }) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.listDrafts(params);
  }

  // Additional mail operations
  async count() {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.count();
  }

  async list(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.getThreadsFromDB(params);
  }

  async markAsRead(threadIds: string[]) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.markAsRead(threadIds);
  }

  async markAsUnread(threadIds: string[]) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.markAsUnread(threadIds);
  }

  async normalizeIds(ids: string[]) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return this.driver.normalizeIds(ids);
  }

  async get(id: string) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.getThreadFromDB(id);
  }

  async sendDraft(id: string, data: IOutgoingMessage) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.sendDraft(id, data);
  }

  async create(data: IOutgoingMessage) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.create(data);
  }

  async delete(id: string) {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.delete(id);
  }

  async deleteAllSpam() {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.deleteAllSpam();
  }

  async getEmailAliases() {
    if (!this.driver) {
      throw new Error('No driver available');
    }
    return await this.driver.getEmailAliases();
  }

  async getThreadCount() {
    const count = this.sql`SELECT COUNT(*) FROM threads`;
    return count[0]['COUNT(*)'] as number;
  }

  async syncThread(threadId: string) {
    if (!this.driver && this.name !== 'general') {
      await this.setupAuth(this.name);
    }

    if (!this.driver) {
      console.error('No driver available for syncThread');
      throw new Error('No driver available');
    }

    if (this.syncThreadsInProgress.has(threadId)) {
      console.log(`Sync already in progress for thread ${threadId}, skipping...`);
      return;
    }
    this.syncThreadsInProgress.set(threadId, true);

    console.log('Server: syncThread called for thread', threadId);
    try {
      const threadData = await this.getWithRetry(threadId);
      const latest = threadData.latest;

      if (latest) {
        // Convert receivedOn to ISO format for proper sorting
        const normalizedReceivedOn = new Date(latest.receivedOn).toISOString();

        await env.THREADS_BUCKET.put(this.getThreadKey(threadId), JSON.stringify(threadData), {
          customMetadata: {
            threadId,
          },
        });

        this.sql`
          INSERT OR REPLACE INTO threads (
            id, 
            thread_id, 
            provider_id,  
            latest_sender, 
            latest_received_on, 
            latest_subject, 
            latest_label_ids,
            updated_at
          ) VALUES (
            ${threadId},
            ${threadId},
            'google',
            ${JSON.stringify(latest.sender)},
            ${normalizedReceivedOn},
            ${latest.subject},
            ${JSON.stringify(latest.tags.map((tag) => tag.id))},
            CURRENT_TIMESTAMP
          )
        `;
        if (this.currentFolder === 'inbox') {
          this.broadcastChatMessage({
            type: OutgoingMessageType.Mail_Get,
            threadId,
          });
        }
        this.syncThreadsInProgress.delete(threadId);
        console.log('Server: syncThread result', {
          threadId,
          labels: threadData.labels,
        });
        return { success: true, threadId, threadData };
      } else {
        this.syncThreadsInProgress.delete(threadId);
        console.log(`Skipping thread ${threadId} - no latest message`);
        return { success: false, threadId, reason: 'No latest message' };
      }
    } catch (error) {
      this.syncThreadsInProgress.delete(threadId);
      console.error(`Failed to sync thread ${threadId}:`, error);
      throw error;
    }
  }

  getThreadKey(threadId: string) {
    return `${this.name}/${threadId}.json`;
  }

  private async listWithRetry(params: Parameters<MailManager['list']>[0]) {
    if (!this.driver) throw new Error('No driver available');

    return Effect.runPromise(withRetry(Effect.tryPromise(() => this.driver!.list(params))));
  }

  private async getWithRetry(threadId: string): Promise<IGetThreadResponse> {
    if (!this.driver) throw new Error('No driver available');

    return Effect.runPromise(withRetry(Effect.tryPromise(() => this.driver!.get(threadId))));
  }

  async syncThreads(folder: string) {
    if (!this.driver) {
      console.error('No driver available for syncThreads');
      throw new Error('No driver available');
    }

    if (this.foldersInSync.has(folder)) {
      console.log('Sync already in progress, skipping...');
      return { synced: 0, message: 'Sync already in progress' };
    }

    const threadCount = await this.getThreadCount();
    if (threadCount >= maxCount && !shouldLoop) {
      console.log('Threads already synced, skipping...');
      return { synced: 0, message: 'Threads already synced' };
    }

    this.foldersInSync.set(folder, true);

    try {
      let totalSynced = 0;
      let pageToken: string | null = null;
      let hasMore = true;
      let _pageCount = 0;

      while (hasMore) {
        _pageCount++;

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const result = await this.listWithRetry({
          folder,
          maxResults: maxCount,
          pageToken: pageToken || undefined,
        });

        // Need delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 2000));

        for (const thread of result.threads) {
          try {
            await this.syncThread(thread.id);
            // Need delay to avoid rate limiting
            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch (error) {
            console.error(`Failed to sync thread ${thread.id}:`, error);
          }
        }

        this.broadcastChatMessage({
          type: OutgoingMessageType.Mail_List,
          folder,
        });

        totalSynced += result.threads.length;
        pageToken = result.nextPageToken;
        hasMore = pageToken !== null && shouldLoop;
      }

      return { synced: totalSynced };
    } catch (error) {
      console.error('Failed to sync inbox threads:', error);
      throw error;
    } finally {
      console.log('Setting isSyncing to false');
      this.foldersInSync.delete(folder);
      this.broadcastChatMessage({
        type: OutgoingMessageType.Mail_List,
        folder,
      });
    }
  }

  async inboxRag(query: string) {
    if (!env.AUTORAG_ID) return { result: 'Not enabled', data: [] };
    const answer = await env.AI.autorag(env.AUTORAG_ID).aiSearch({
      query: query,
      //   rewrite_query: true,
      max_num_results: 3,
      ranking_options: {
        score_threshold: 0.3,
      },
      //   stream: true,
      filters: {
        type: 'eq',
        key: 'folder',
        value: `${this.name}/`,
      },
    });
    return { result: answer.response, data: answer.data };
  }

  async searchThreads(params: {
    query: string;
    folder?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    const { query, folder = 'inbox', maxResults = 50, labelIds = [], pageToken } = params;

    if (!this.driver) {
      throw new Error('No driver available');
    }

    // Create parallel Effect operations
    const ragEffect = Effect.tryPromise(() =>
      this.inboxRag(query).then((rag) => {
        const ids = rag?.data?.map((d) => d.attributes.threadId).filter(Boolean) ?? [];
        return ids.slice(0, maxResults);
      }),
    ).pipe(Effect.catchAll(() => Effect.succeed([])));

    const rawEffect = Effect.tryPromise(() =>
      this.driver!.list({
        folder,
        query,
        labelIds,
        maxResults,
        pageToken,
      }).then((r) => r.threads.map((t) => t.id)),
    ).pipe(Effect.catchAll(() => Effect.succeed([])));

    // Run both in parallel and wait for results
    const results = await Effect.runPromise(
      Effect.all([ragEffect, rawEffect], { concurrency: 'unbounded' }),
    );

    const [ragIds, rawIds] = results;

    // Return InboxRag results if found, otherwise fallback to raw
    if (ragIds.length > 0) {
      return {
        threadIds: ragIds,
        source: 'autorag' as const,
      };
    }

    return {
      threadIds: rawIds,
      source: 'raw' as const,
      nextPageToken: pageToken,
    };
  }

  async getThreadsFromDB(params: {
    labelIds?: string[];
    folder?: string;
    q?: string;
    maxResults?: number;
    pageToken?: string;
  }) {
    const { labelIds = [], folder, q, maxResults = 50, pageToken } = params;

    try {
      // Build WHERE conditions
      const whereConditions: string[] = [];

      // Add folder condition (maps to specific label)
      if (folder) {
        const folderLabel = folder.toUpperCase();
        whereConditions.push(`EXISTS (
            SELECT 1 FROM json_each(latest_label_ids) WHERE value = '${folderLabel}'
          )`);
      }

      // Add label conditions (OR logic for multiple labels)
      if (labelIds.length > 0) {
        if (labelIds.length === 1) {
          whereConditions.push(`EXISTS (
              SELECT 1 FROM json_each(latest_label_ids) WHERE value = '${labelIds[0]}'
            )`);
        } else {
          // Multiple labels with OR logic
          const multiLabelCondition = labelIds
            .map(
              (labelId) =>
                `EXISTS (SELECT 1 FROM json_each(latest_label_ids) WHERE value = '${labelId}')`,
            )
            .join(' OR ');
          whereConditions.push(`(${multiLabelCondition})`);
        }
      }

      //   // Add search query condition
      if (q) {
        const searchTerm = q.replace(/'/g, "''"); // Escape single quotes
        whereConditions.push(`(
            latest_subject LIKE '%${searchTerm}%' OR
            latest_sender LIKE '%${searchTerm}%'
          )`);
      }

      // Add cursor condition
      if (pageToken) {
        whereConditions.push(`latest_received_on < '${pageToken}'`);
      }

      // Execute query based on conditions
      let result;

      if (whereConditions.length === 0) {
        // No conditions
        result = await this.sql`
            SELECT id, latest_received_on
            FROM threads
            ORDER BY latest_received_on DESC
            LIMIT ${maxResults}
          `;
      } else if (whereConditions.length === 1) {
        // Single condition
        const condition = whereConditions[0];
        if (condition.includes('latest_received_on <')) {
          const cursorValue = pageToken!;
          result = await this.sql`
              SELECT id, latest_received_on
              FROM threads
              WHERE latest_received_on < ${cursorValue}
              ORDER BY latest_received_on DESC
              LIMIT ${maxResults}
            `;
        } else if (folder) {
          // Folder condition
          const folderLabel = folder.toUpperCase();
          result = await this.sql`
              SELECT id, latest_received_on
              FROM threads
              WHERE EXISTS (
                SELECT 1 FROM json_each(latest_label_ids) WHERE value = ${folderLabel}
              )
              ORDER BY latest_received_on DESC
              LIMIT ${maxResults}
            `;
        } else {
          // Single label condition
          const labelId = labelIds[0];
          result = await this.sql`
              SELECT id, latest_received_on
              FROM threads
              WHERE EXISTS (
                SELECT 1 FROM json_each(latest_label_ids) WHERE value = ${labelId}
              )
              ORDER BY latest_received_on DESC
              LIMIT ${maxResults}
            `;
        }
      } else {
        // Multiple conditions - handle combinations
        if (folder && labelIds.length === 0 && pageToken) {
          // Folder + cursor
          const folderLabel = folder.toUpperCase();
          result = await this.sql`
              SELECT id, latest_received_on
              FROM threads
              WHERE EXISTS (
                SELECT 1 FROM json_each(latest_label_ids) WHERE value = ${folderLabel}
              ) AND latest_received_on < ${pageToken}
              ORDER BY latest_received_on DESC
              LIMIT ${maxResults}
            `;
        } else if (labelIds.length === 1 && pageToken && !folder) {
          // Single label + cursor
          const labelId = labelIds[0];
          result = await this.sql`
              SELECT id, latest_received_on
              FROM threads
              WHERE EXISTS (
                SELECT 1 FROM json_each(latest_label_ids) WHERE value = ${labelId}
              ) AND latest_received_on < ${pageToken}
              ORDER BY latest_received_on DESC
              LIMIT ${maxResults}
            `;
        } else {
          // For now, fallback to just cursor if complex combinations
          const cursorValue = pageToken || '';
          result = await this.sql`
              SELECT id, latest_received_on
              FROM threads
              WHERE latest_received_on < ${cursorValue}
              ORDER BY latest_received_on DESC
              LIMIT ${maxResults}
            `;
        }
      }

      const threads = result.map((row: any) => ({
        id: row.id,
        historyId: null,
      }));

      // Use latest_received_on for pagination cursor
      const nextPageToken =
        threads.length === maxResults && result.length > 0
          ? result[result.length - 1].latest_received_on
          : null;

      return {
        threads,
        nextPageToken,
      };
    } catch (error) {
      console.error('Failed to get threads from database:', error);
      throw error;
    }
  }

  async getThreadFromDB(id: string, lastAttempt = false): Promise<IGetThreadResponse> {
    try {
      const result = this.sql`
          SELECT
            id,
            thread_id,
            provider_id,
            latest_sender,
            latest_received_on,
            latest_subject,
            latest_label_ids,
            created_at,
            updated_at
          FROM threads
          WHERE id = ${id}
          LIMIT 1
        `;

      if (!result || result.length === 0) {
        if (lastAttempt) {
          throw new Error('Thread not found in database, Sync Failed once');
        }
        await this.syncThread(id);
        return this.getThreadFromDB(id, true);
      }
      const row = result[0] as any;
      const storedThread = await env.THREADS_BUCKET.get(this.getThreadKey(id));

      const messages: ParsedMessage[] = storedThread
        ? (JSON.parse(await storedThread.text()) as IGetThreadResponse).messages
        : [];

      const latestLabelIds = JSON.parse(row.latest_label_ids || '[]');

      return {
        messages,
        latest: messages.findLast((e) => e.isDraft !== true),
        hasUnread: latestLabelIds.includes('UNREAD'),
        totalReplies: messages.filter((e) => e.isDraft !== true).length,
        labels: latestLabelIds.map((id: string) => ({ id, name: id })),
      } satisfies IGetThreadResponse;
    } catch (error) {
      console.error('Failed to get thread from database:', error);
      throw error;
    }
  }
}

export class ZeroMCP extends McpAgent<typeof env, {}, { userId: string }> {
  server = new McpServer({
    name: 'zero-mcp',
    version: '1.0.0',
    description: 'Zero MCP',
  });

  activeConnectionId: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async init(): Promise<void> {
    const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
    const _connection = await db.query.connection.findFirst({
      where: eq(connection.userId, this.props.userId),
    });
    if (!_connection) {
      throw new Error('Unauthorized');
    }
    this.activeConnectionId = _connection.id;
    this.server.registerTool(
      'getConnections',
      {
        description:
          'Use this tool to get all connections for the user. This helps you know what accounts(connections) the user has available.',
        inputSchema: {},
      },
      async () => {
        const connections = await db.query.connection.findMany({
          where: eq(connection.userId, this.props.userId),
        });
        return {
          content: connections.map((c) => ({
            type: 'text',
            text: `Email: ${c.email} | Provider: ${c.providerId}`,
          })),
        };
      },
    );

    this.server.registerTool(
      'getActiveConnection',
      {
        description: 'Get the currently active email connection',
      },
      async () => {
        if (!this.activeConnectionId) {
          throw new Error('No active connection');
        }
        const _connection = await db.query.connection.findFirst({
          where: eq(connection.id, this.activeConnectionId),
        });
        if (!_connection) {
          throw new Error('Connection not found');
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Email: ${_connection.email} | Provider: ${_connection.providerId}`,
            },
          ],
        };
      },
    );

    this.server.registerTool(
      'setActiveConnection',
      {
        description: 'Set the active email connection by email address',
        inputSchema: {
          email: z.string(),
        },
      },
      async (s) => {
        const _connection = await db.query.connection.findFirst({
          where: and(eq(connection.userId, this.props.userId), eq(connection.email, s.email)),
        });
        if (!_connection) {
          throw new Error('Connection not found');
        }
        this.activeConnectionId = _connection.id;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Active connection set to ${_connection.email}`,
            },
          ],
        };
      },
    );

    this.server.registerTool(
      'buildGmailSearchQuery',
      {
        description: 'Build Gmail search query using AI assistance',
        inputSchema: {
          query: z.string(),
        },
      },
      async (s) => {
        const result = await generateText({
          model: anthropic(env.OPENAI_MODEL || 'claude-3-5-haiku-latest'),
          system: GmailSearchAssistantSystemPrompt(),
          prompt: s.query,
        });
        return {
          content: [
            {
              type: 'text',
              text: result.text,
            },
          ],
        };
      },
    );

    const agent = await getZeroAgent(_connection.id);

    this.server.registerTool(
      'listThreads',
      {
        description: 'List email threads with optional filters and pagination',
        inputSchema: {
          folder: z.string().default(FOLDERS.INBOX),
          query: z.string().optional(),
          maxResults: z.number().optional().default(5),
          labelIds: z.array(z.string()).optional(),
          pageToken: z.string().optional(),
        },
      },
      async (s) => {
        const result = await agent.listThreads({
          folder: s.folder,
          query: s.query,
          maxResults: s.maxResults,
          labelIds: s.labelIds,
          pageToken: s.pageToken,
        });
        const content = await Promise.all(
          result.threads.map(async (thread: any) => {
            const loadedThread = await agent.getThread(thread.id);
            return [
              {
                type: 'text' as const,
                text: `Subject: ${loadedThread.latest?.subject} | ID: ${thread.id} | Latest Message Received: ${loadedThread.latest?.receivedOn}`,
              },
              {
                type: 'text' as const,
                text: `Latest Message Sender: ${loadedThread.latest?.sender}`,
              },
            ];
          }),
        );
        return {
          content: content.length
            ? content.flat()
            : [
                {
                  type: 'text' as const,
                  text: 'No threads found',
                },
              ],
        };
      },
    );

    this.server.registerTool(
      'getThread',
      {
        description: 'Get detailed information about a specific email thread',
        inputSchema: {
          threadId: z.string(),
        },
      },
      async (s) => {
        const thread = await agent.getThread(s.threadId);
        const initialResponse = [
          {
            type: 'text' as const,
            text: `Subject: ${thread.latest?.subject}`,
          },
          {
            type: 'text' as const,
            text: `Latest Message Received: ${thread.latest?.receivedOn}`,
          },
          {
            type: 'text' as const,
            text: `Latest Message Sender: ${thread.latest?.sender.name} <${thread.latest?.sender.email}>`,
          },
          {
            type: 'text' as const,
            text: `Latest Message Raw Content: ${thread.latest?.decodedBody}`,
          },
          {
            type: 'text' as const,
            text: `Thread ID: ${s.threadId}`,
          },
        ];
        return {
          content: initialResponse,
        };
      },
    );

    this.server.registerTool(
      'markThreadsRead',
      {
        description: 'Mark email threads as read',
        inputSchema: {
          threadIds: z.array(z.string()),
        },
      },
      async (s) => {
        await agent.modifyLabels(s.threadIds, [], ['UNREAD']);
        return {
          content: [
            {
              type: 'text',
              text: 'Threads marked as read',
            },
          ],
        };
      },
    );

    this.server.registerTool(
      'markThreadsUnread',
      {
        description: 'Mark email threads as unread',
        inputSchema: {
          threadIds: z.array(z.string()),
        },
      },
      async (s) => {
        await agent.modifyLabels(s.threadIds, ['UNREAD'], []);
        return {
          content: [
            {
              type: 'text',
              text: 'Threads marked as unread',
            },
          ],
        };
      },
    );

    this.server.registerTool(
      'modifyLabels',
      {
        description: 'Add or remove labels from email threads',
        inputSchema: {
          threadIds: z.array(z.string()),
          addLabelIds: z.array(z.string()),
          removeLabelIds: z.array(z.string()),
        },
      },
      async (s) => {
        await agent.modifyLabels(s.threadIds, s.addLabelIds, s.removeLabelIds);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully modified ${s.threadIds.length} thread(s)`,
            },
          ],
        };
      },
    );

    this.server.registerTool(
      'getCurrentDate',
      {
        description: 'Get the current date and time',
        inputSchema: z.object({}).shape,
      },
      async () => {
        return {
          content: [
            {
              type: 'text',
              text: getCurrentDateContext(),
            },
          ],
        };
      },
    );

    this.server.registerTool(
      'getUserLabels',
      { description: 'Get all available labels for the user' },
      async () => {
        const labels = await agent.getUserLabels();
        return {
          content: [
            {
              type: 'text',
              text: labels
                .map((label) => `Name: ${label.name} ID: ${label.id} Color: ${label.color}`)
                .join('\n'),
            },
          ],
        };
      },
    );

    this.server.registerTool(
      'getLabel',
      {
        description: 'Get details about a specific label',
        inputSchema: {
          id: z.string(),
        },
      },
      async (s) => {
        const label = await agent.getLabel(s.id);
        return {
          content: [
            {
              type: 'text',
              text: `Name: ${label.name}`,
            },
            {
              type: 'text',
              text: `ID: ${label.id}`,
            },
          ],
        };
      },
    );

    this.server.registerTool(
      'createLabel',
      {
        description: 'Create a new email label',
        inputSchema: {
          name: z.string(),
          backgroundColor: z.string().optional(),
          textColor: z.string().optional(),
        },
      },
      async (s) => {
        try {
          await agent.createLabel({
            name: s.name,
            color:
              s.backgroundColor && s.textColor
                ? {
                    backgroundColor: s.backgroundColor,
                    textColor: s.textColor,
                  }
                : undefined,
          });
          return {
            content: [
              {
                type: 'text',
                text: 'Label has been created',
              },
            ],
          };
        } catch (e) {
          console.error(e);
          return {
            content: [
              {
                type: 'text',
                text: 'Failed to create label',
              },
            ],
          };
        }
      },
    );

    // this.server.registerTool(
    //   'bulkDelete',
    //   {
    //     description: 'Move multiple threads to trash',
    //     inputSchema: {
    //       threadIds: z.array(z.string()),
    //     },
    //   },
    //   async (s) => {
    //     try {
    //       await agent.modifyLabels(s.threadIds, ['TRASH'], ['INBOX']);
    //       return {
    //         content: [
    //           {
    //             type: 'text',
    //             text: 'Threads moved to trash',
    //           },
    //         ],
    //       };
    //     } catch (e) {
    //       console.error(e);
    //       return {
    //         content: [
    //           {
    //             type: 'text',
    //             text: 'Failed to move threads to trash',
    //           },
    //         ],
    //       };
    //     }
    //   },
    // );

    // this.server.registerTool(
    //   'bulkArchive',
    //   {
    //     description: 'Archive multiple email threads',
    //     inputSchema: {
    //       threadIds: z.array(z.string()),
    //     },
    //   },
    //   async (s) => {
    //     try {
    //       await agent.modifyLabels(s.threadIds, [], ['INBOX']);
    //       return {
    //         content: [
    //           {
    //             type: 'text',
    //             text: 'Threads archived',
    //           },
    //         ],
    //       };
    //     } catch (e) {
    //       console.error(e);
    //       return {
    //         content: [
    //           {
    //             type: 'text',
    //             text: 'Failed to archive threads',
    //           },
    //         ],
    //       };
    //     }
    //   },
    // );
    this.ctx.waitUntil(conn.end());
  }
}
