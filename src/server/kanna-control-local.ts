/**
 * In-process executor for the Kanna management tools: maps a tool name onto
 * the matching control.ts call, in the server process that owns the store.
 *
 * Used by the Claude in-process MCP server. The stdio bridge Codex uses has
 * its own executor that goes over HTTP but hits the same control functions on
 * the other end, so the two agents get identical behaviour.
 */

import {
  addProject,
  cancelChat,
  createChat,
  getChat,
  listChats,
  listProjects,
  reloadFromDisk,
  sendMessage,
  type ControlCaller,
  type ControlDeps,
  type PromptFields,
} from "./api/control"
import type { KannaToolContext, KannaToolOperation } from "./kanna-tools"

function str(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing or empty "${field}"`)
  return value
}

function optionalStr(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error(`"${field}" must be a string`)
  return value
}

function optionalBool(input: Record<string, unknown>, field: string): boolean | undefined {
  const value = input[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new Error(`"${field}" must be a boolean`)
  return value
}

function optionalNum(input: Record<string, unknown>, field: string): number | undefined {
  const value = input[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${field}" must be a number`)
  return value
}

function promptFields(input: Record<string, unknown>): PromptFields {
  return {
    provider: optionalStr(input, "provider") as PromptFields["provider"],
    model: optionalStr(input, "model"),
    effort: optionalStr(input, "effort"),
    planMode: optionalBool(input, "planMode"),
  }
}

export function createLocalKannaControl(deps: ControlDeps, caller: ControlCaller): KannaToolContext {
  return {
    async call(operation: KannaToolOperation, input: Record<string, unknown>) {
      switch (operation) {
        case "list_projects":
          return listProjects(deps)
        case "add_project":
          return await addProject(deps, {
            localPath: str(input, "localPath"),
            title: optionalStr(input, "title"),
          })
        case "list_chats":
          return listChats(deps, {
            projectId: optionalStr(input, "projectId"),
            includeArchived: optionalBool(input, "includeArchived"),
            limit: optionalNum(input, "limit"),
          })
        case "get_chat":
          return getChat(deps, { chatId: str(input, "chatId"), full: optionalBool(input, "full") })
        case "create_chat":
          return await createChat(
            deps,
            { projectId: str(input, "projectId"), content: optionalStr(input, "content"), ...promptFields(input) },
            caller
          )
        case "send_message":
          return await sendMessage(
            deps,
            { chatId: str(input, "chatId"), content: str(input, "content"), ...promptFields(input) },
            caller
          )
        case "cancel_chat":
          return await cancelChat(deps, { chatId: str(input, "chatId") })
        case "reload":
          return await reloadFromDisk(deps)
      }
    },
  }
}
