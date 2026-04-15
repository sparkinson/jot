import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const JOT_URL = process.env.JOT_URL;
const JOT_API_KEY = process.env.JOT_API_KEY;

if (!JOT_URL || !JOT_API_KEY) {
  console.error("Missing required environment variables: JOT_URL and JOT_API_KEY");
  process.exit(1);
}

const baseUrl = JOT_URL.replace(/\/$/, "");

async function api(method: string, endpoint: string, body?: unknown): Promise<unknown> {
  const url = `${baseUrl}${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${JOT_API_KEY}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  const res = await fetch(url, options);
  const payload = await res.json();

  if (!res.ok) {
    const msg = (payload as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return payload;
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

// --- Server setup ---

const server = new McpServer(
  { name: "jot", version: "1.0.0" },
  {
    instructions:
      "Jot is a collaborative markdown editor. Use these tools to manage notes, comments, and sharing. " +
      "Call jot_list_notes or jot_search_notes to find notes. Call jot_read_note to get content and comments. " +
      "Thread and message IDs are returned by jot_read_note — use them for replies, edits, and deletions.",
  },
);

// --- Notes ---

server.tool("jot_list_notes", "List all notes", {}, async () => {
  try {
    const payload = (await api("GET", "/api/notes")) as {
      notes: Array<{ id: string; title: string; updatedAt: string }>;
    };
    const lines = payload.notes.map((n) => `${n.id}\t${n.title}\t${n.updatedAt}`);
    return text(lines.join("\n") || "No notes.");
  } catch (err) {
    return errorResult(err);
  }
});

server.tool(
  "jot_search_notes",
  "Search notes by query",
  { query: z.string().describe("Search query") },
  async ({ query }) => {
    try {
      const payload = (await api("GET", `/api/notes?q=${encodeURIComponent(query)}`)) as {
        notes: Array<{ id: string; title: string; updatedAt: string }>;
      };
      const lines = payload.notes.map((n) => `${n.id}\t${n.title}\t${n.updatedAt}`);
      return text(lines.join("\n") || "No matching notes.");
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_read_note",
  "Read a note's content and comments. Supports offset/limit for large notes.",
  {
    noteId: z.string().describe("Note ID"),
    offset: z.number().optional().describe("Line offset to start reading from"),
    limit: z.number().optional().describe("Number of lines to read"),
  },
  async ({ noteId, offset, limit }) => {
    try {
      const params: string[] = [];
      if (offset !== undefined) params.push(`offset=${offset}`);
      if (limit !== undefined) params.push(`limit=${limit}`);
      const qs = params.length ? `?${params.join("&")}` : "";

      const payload = (await api("GET", `/api/notes/${noteId}${qs}`)) as {
        note: {
          id: string;
          title: string;
          markdown?: string;
          content?: string;
          updatedAt: string;
          shareUrl: string;
          shareAccess: string;
          offset?: number;
          limit?: number;
          totalLines?: number;
          remaining?: number;
        };
        threads?: Array<{
          id: string;
          anchor?: { quote?: string };
          resolved: boolean;
          messages: Array<{
            id: string;
            authorName: string;
            body: string;
            updatedAt: string;
          }>;
        }>;
      };

      const note = payload.note;
      const lines: string[] = [];

      lines.push(`# ${note.title}`);
      lines.push(`# id: ${note.id}`);
      lines.push(`# share: ${note.shareAccess} — ${note.shareUrl}`);

      if (note.content !== undefined) {
        lines.push(
          `# lines: ${note.offset}-${(note.offset ?? 0) + (note.limit ?? 0) - 1} of ${note.totalLines}${(note.remaining ?? 0) > 0 ? ` (${note.remaining} more)` : ""}`,
        );
        lines.push("");
        lines.push(note.content);
      } else {
        lines.push(`# updated: ${note.updatedAt}`);
        lines.push("");
        lines.push(note.markdown ?? "");
      }

      if (payload.threads && payload.threads.length > 0) {
        lines.push("");
        lines.push("--- Comments ---");
        for (const thread of payload.threads) {
          const anchor = thread.anchor?.quote
            ? `"${thread.anchor.quote.slice(0, 60)}"`
            : "(no anchor)";
          lines.push("");
          lines.push(
            `Thread ${thread.id} on ${anchor}${thread.resolved ? " [resolved]" : ""}`,
          );
          for (const msg of thread.messages) {
            lines.push(
              `  [${msg.id}] ${msg.authorName} (${msg.updatedAt}): ${msg.body}`,
            );
          }
        }
      }

      return text(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_create_note",
  "Create a new note",
  { title: z.string().optional().describe("Note title (defaults to 'untitled')") },
  async ({ title }) => {
    try {
      const payload = (await api("POST", "/api/notes")) as {
        note: { id: string };
      };
      const noteTitle = title || "untitled";
      if (title) {
        await api("PUT", `/api/notes/${payload.note.id}`, {
          title,
          markdown: "",
        });
      }
      return text(`${payload.note.id}\t${noteTitle}`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_update_note",
  "Update a note's title or markdown content",
  {
    noteId: z.string().describe("Note ID"),
    field: z.enum(["title", "markdown"]).describe("Field to update"),
    value: z.string().describe("New value"),
  },
  async ({ noteId, field, value }) => {
    try {
      const current = (await api("GET", `/api/notes/${noteId}`)) as {
        note: { title: string; markdown: string };
      };
      const body =
        field === "title"
          ? { title: value, markdown: current.note.markdown }
          : { title: current.note.title, markdown: value };
      const payload = (await api("PUT", `/api/notes/${noteId}`, body)) as {
        savedAt: string;
      };
      return text(`Saved at ${payload.savedAt}`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_delete_note",
  "Delete a note",
  { noteId: z.string().describe("Note ID") },
  async ({ noteId }) => {
    try {
      await api("DELETE", `/api/notes/${noteId}`);
      return text(`Deleted ${noteId}`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_edit_note",
  "Apply text edits to a note (search and replace)",
  {
    noteId: z.string().describe("Note ID"),
    edits: z
      .array(
        z.object({
          oldText: z.string().describe("Text to find"),
          newText: z.string().describe("Replacement text"),
        }),
      )
      .describe("Array of search-and-replace edits"),
  },
  async ({ noteId, edits }) => {
    try {
      const payload = (await api("POST", `/api/notes/${noteId}/edit`, {
        edits,
      })) as { savedAt: string };
      return text(`Saved at ${payload.savedAt}`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_share",
  "Get or set share access for a note. Call without access to get current status.",
  {
    noteId: z.string().describe("Note ID"),
    access: z
      .enum(["none", "view", "comment", "edit"])
      .optional()
      .describe("Access level to set (omit to get current)"),
  },
  async ({ noteId, access }) => {
    try {
      if (access) {
        await api("PUT", `/api/notes/${noteId}`, { shareAccess: access });
      }
      const payload = (await api("GET", `/api/notes/${noteId}`)) as {
        note: { id: string; shareAccess: string; shareUrl: string };
      };
      return text(
        `${payload.note.id}\t${payload.note.shareAccess}\t${payload.note.shareUrl}`,
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Comments & Threads ---

server.tool(
  "jot_comment",
  "Create a comment thread on quoted text in a note",
  {
    noteId: z.string().describe("Note ID"),
    quote: z.string().describe("The text to comment on (must exist in the note)"),
    body: z.string().describe("Comment body"),
  },
  async ({ noteId, quote, body }) => {
    try {
      const payload = (await api("POST", `/api/notes/${noteId}/threads`, {
        quote,
        body,
      })) as { thread: { id: string } };
      return text(`Comment added (thread ${payload.thread.id})`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_reply",
  "Reply to a comment thread",
  {
    noteId: z.string().describe("Note ID"),
    threadId: z.string().describe("Thread ID"),
    messageId: z.string().describe("Message ID to reply to"),
    body: z.string().describe("Reply body"),
  },
  async ({ noteId, threadId, messageId, body }) => {
    try {
      await api("POST", `/api/notes/${noteId}/threads/${threadId}/replies`, {
        body,
        parentMessageId: messageId,
      });
      return text("Reply added");
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_resolve_thread",
  "Resolve a comment thread",
  {
    noteId: z.string().describe("Note ID"),
    threadId: z.string().describe("Thread ID"),
  },
  async ({ noteId, threadId }) => {
    try {
      await api("PATCH", `/api/notes/${noteId}/threads/${threadId}`, {
        resolved: true,
      });
      return text("Thread resolved");
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_reopen_thread",
  "Reopen a resolved comment thread",
  {
    noteId: z.string().describe("Note ID"),
    threadId: z.string().describe("Thread ID"),
  },
  async ({ noteId, threadId }) => {
    try {
      await api("PATCH", `/api/notes/${noteId}/threads/${threadId}`, {
        resolved: false,
      });
      return text("Thread reopened");
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_delete_thread",
  "Delete a comment thread",
  {
    noteId: z.string().describe("Note ID"),
    threadId: z.string().describe("Thread ID"),
  },
  async ({ noteId, threadId }) => {
    try {
      await api("DELETE", `/api/notes/${noteId}/threads/${threadId}`);
      return text("Thread deleted");
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_edit_comment",
  "Edit a comment's body",
  {
    noteId: z.string().describe("Note ID"),
    messageId: z.string().describe("Message ID"),
    body: z.string().describe("New comment body"),
  },
  async ({ noteId, messageId, body }) => {
    try {
      await api("PATCH", `/api/notes/${noteId}/messages/${messageId}`, {
        body,
      });
      return text("Comment edited");
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "jot_delete_comment",
  "Delete a comment",
  {
    noteId: z.string().describe("Note ID"),
    messageId: z.string().describe("Message ID"),
  },
  async ({ noteId, messageId }) => {
    try {
      await api("DELETE", `/api/notes/${noteId}/messages/${messageId}`);
      return text("Comment deleted");
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Jot MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
