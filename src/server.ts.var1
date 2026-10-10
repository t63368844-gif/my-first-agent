import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  waitForMcpConnections = true;

  onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a helpful assistant that can understand images. You can check the weather, get the user's timezone, run calculations, and schedule tasks. When users share images, describe what you see and answer questions about them.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the scheduleTask tool with a clear "when" string (e.g. "in 30 seconds", "in 5 minutes", "2026-01-15T09:00:00Z", or a cron expression like "*/10 * * * *"). Always provide BOTH the "when" and "description" parameters.`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        ...mcpTools,

        // ── Server-side: weather ────────────────────────────────
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            const conditions = ["sunny", "cloudy", "rainy", "snowy"];
            const temp = Math.floor(Math.random() * 30) + 5;
            return {
              city,
              temperature: temp,
              condition: conditions[Math.floor(Math.random() * conditions.length)],
              unit: "celsius"
            };
          }
        }),

        // ── Client-side: timezone ──────────────────────────────
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        // ── Approval tool: calculator ──────────────────────────
        calculate: tool({
          description:
            "Perform a math calculation with two numbers. Requires user approval for large numbers.",
          inputSchema: z.object({
            a: z.number().describe("First number"),
            b: z.number().describe("Second number"),
            operator: z.enum(["+", "-", "*", "/", "%"]).describe("Arithmetic operator")
          }),
          needsApproval: async ({ a, b }) => Math.abs(a) > 1000 || Math.abs(b) > 1000,
          execute: async ({ a, b, operator }) => {
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };
            if (operator === "/" && b === 0) return { error: "Division by zero" };
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        }),

        // ── FIXED scheduleTask: simple schema, null-guarded ────
        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later. You MUST provide BOTH 'when' and 'description' parameters.",
          inputSchema: z.object({
            when: z
              .string()
              .describe(
                'When to run the task. Examples: "in 30 seconds", "in 5 minutes", "2026-01-15T09:00:00Z", or a cron expression like "*/10 * * * *"'
              ),
            description: z.string().describe("A description of what the task should do")
          }),
          execute: async ({ when: whenStr, description }) => {
            try {
              // ── Null guard: protect against empty input from the model
              if (!whenStr || typeof whenStr !== "string" || whenStr.trim() === "") {
                return "ERROR: missing 'when' parameter. Please specify when to schedule (e.g. 'in 30 seconds').";
              }
              if (!description || typeof description !== "string" || description.trim() === "") {
                return "ERROR: missing 'description' parameter. Please describe what to schedule.";
              }

              let input: number | Date | string;
              const delayMatch = whenStr.match(/in\s+(\d+)\s+(second|minute|hour)s?/i);
              const asNum = Number(whenStr);

              if (delayMatch) {
                const val = parseInt(delayMatch[1]);
                const unit = delayMatch[2].toLowerCase();
                input = unit === "second" ? val : unit === "minute" ? val * 60 : val * 3600;
              } else if (!isNaN(asNum) && whenStr.trim() !== "") {
                input = asNum;
              } else if (whenStr.includes("*")) {
                input = whenStr; // cron expression
              } else {
                input = new Date(whenStr);
              }

              await this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled successfully: "${description}" for ${whenStr}`;
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              return `Error scheduling task: ${msg}`;
            }
          }
        }),

        // ── List scheduled tasks ───────────────────────────────
        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        // ── Cancel a scheduled task ────────────────────────────
        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              return `Error cancelling task: ${msg}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Executing scheduled task: ${description}`);
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
