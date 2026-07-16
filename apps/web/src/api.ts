import type { Account, Message, ProviderInfo, Stats } from "./types";

export type MessagePage = { items: Message[]; total: number; page: number; pageSize: number };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as { message?: string } & T;
  if (!response.ok) throw new Error(body.message || "请求失败，请稍后重试。");
  return body;
}

export const api = {
  accounts: () => request<Account[]>("/api/accounts"),
  providers: () => request<ProviderInfo[]>("/api/providers"),
  stats: () => request<Stats>("/api/stats"),
  messages: (query = "") =>
    request<MessagePage>(`/api/messages${query ? `?${query}` : ""}`),
  message: (id: string) => request<Message>(`/api/messages/${encodeURIComponent(id)}`),
  testAccount: (email: string, password: string) =>
    request<{ ok: boolean; provider: string; folders: number; warning?: string }>("/api/accounts/test", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  addAccount: (email: string, password: string) =>
    request<{
      ok: boolean;
      account: Account;
      sync: { synced: number; folders: number; failedFolders: number } | null;
      syncWarning: string | null;
    }>("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  removeAccount: (id: string) => request<{ ok: boolean }>(`/api/accounts/${id}`, { method: "DELETE" }),
  sync: (id: string) =>
    request<{ ok: boolean; synced: number; folders: number; failedFolders: number }>(`/api/accounts/${id}/sync`, {
      method: "POST",
      body: "{}",
    }),
  markSeen: (id: string, seen: boolean) =>
    request<{ ok: boolean }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ seen }) }),
  send: (payload: { accountId: string; to: string[]; cc?: string[]; subject: string; text: string }) =>
    request<{ ok: boolean; messageId: string }>("/api/messages/send", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
