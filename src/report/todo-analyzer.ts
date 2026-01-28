import type { TodoType } from "@/db/schema";
import type { CategorizedThread, IdentifiedTodo } from "./types";

// Identify action items from categorized threads
export function identifyTodos(threads: CategorizedThread[]): IdentifiedTodo[] {
  const todos: IdentifiedTodo[] = [];

  for (const thread of threads) {
    // Only look at customer threads where last email is NOT from us
    if (thread.category !== "customer") {
      continue;
    }

    // If the last email is from us, no action needed on this thread
    if (thread.lastEmailFromUs) {
      continue;
    }

    // If AI determined no response is needed (e.g., "thanks" message), skip
    if (!thread.needsResponse) {
      continue;
    }

    // Determine the type of todo based on item type
    const todo = identifyTodoForThread(thread);
    if (todo) {
      todos.push(todo);
    }
  }

  return todos;
}

function identifyTodoForThread(thread: CategorizedThread): IdentifiedTodo | null {
  let todoType: TodoType;
  let description: string;

  switch (thread.itemType) {
    case "po_received":
      // Customer sent PO, we haven't acknowledged
      todoType = "po_unacknowledged";
      description = `Customer sent a PO that hasn't been acknowledged yet. ${thread.summary || ""}`.trim();
      break;

    case "quote_request":
      // Customer requested quote, we haven't responded
      todoType = "quote_unanswered";
      description = `Customer requested a quote that hasn't been answered yet. ${thread.summary || ""}`.trim();
      break;

    case "general":
    case "other":
      // General customer email without response
      todoType = "general_unanswered";
      description = `Customer email awaiting response. ${thread.summary || ""}`.trim();
      break;

    default:
      return null;
  }

  return {
    threadKey: thread.threadKey,
    todoType,
    description,
    contactEmail: thread.contactEmail,
    contactName: thread.contactName,
    originalDate: thread.lastEmailDate,
    subject: thread.subject,
  };
}

// Calculate age of a todo item in days
export function calculateTodoAge(originalDate: Date | null): number {
  if (!originalDate) return 0;
  const now = new Date();
  const diffMs = now.getTime() - originalDate.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// Format todo age for display
export function formatTodoAge(originalDate: Date | null): string {
  const days = calculateTodoAge(originalDate);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

// Get todo priority based on type and age
export function getTodoPriority(todoType: TodoType, age: number): "high" | "medium" | "low" {
  // POs are highest priority
  if (todoType === "po_unacknowledged") {
    return "high";
  }

  // Quote requests are medium priority, but become high if old
  if (todoType === "quote_unanswered") {
    return age > 2 ? "high" : "medium";
  }

  // General unanswered become medium if old
  return age > 3 ? "medium" : "low";
}

// Group todos by priority
export function groupTodosByPriority(todos: IdentifiedTodo[]): {
  high: IdentifiedTodo[];
  medium: IdentifiedTodo[];
  low: IdentifiedTodo[];
} {
  const grouped = {
    high: [] as IdentifiedTodo[],
    medium: [] as IdentifiedTodo[],
    low: [] as IdentifiedTodo[],
  };

  for (const todo of todos) {
    const age = calculateTodoAge(todo.originalDate);
    const priority = getTodoPriority(todo.todoType, age);
    grouped[priority].push(todo);
  }

  return grouped;
}

// Format todo type for display
export function formatTodoType(todoType: TodoType): string {
  switch (todoType) {
    case "po_unacknowledged":
      return "PO Unacknowledged";
    case "quote_unanswered":
      return "Quote Unanswered";
    case "general_unanswered":
      return "Awaiting Response";
    default:
      return "Todo";
  }
}
