import type { Env } from "../env.js";
import {
  parseCategoryJSON,
  parseReceiptLinesJSON,
  parseVoiceItemsJSON,
} from "./ai-parse.js";

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "user";
      content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
    };

type ChatBody = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  response_format: { type: "json_object" };
};

export function isOpenAIConfigured(env: Pick<Env, "OPENAI_API_KEY">): boolean {
  return Boolean(env.OPENAI_API_KEY?.trim());
}

async function openAIChat(env: Env, body: ChatBody): Promise<{ choices?: Array<{ message?: { content?: string } }> }> {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("openai_not_configured");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`openai_${response.status}`);
  return JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
}

export async function openAIVoiceItems(env: Env, transcript: string): Promise<string[]> {
  const system = `You extract grocery product names from spoken shopping lists. Return ONLY compact JSON: {"items":["name1","name2"]}.
Rules:
- Keep compound foods as ONE item when they name a single product (e.g. two-word cuts, spreads, or breads), not separate words.
- Words like organic, fresh, frozen, or large that describe the NEXT product stay on that same line (e.g. "organic banana" is one item, not two).
- Separate DISTINCT products: "bread milk eggs" → three items.
- Do not join multiple distinct products into one items[] string when the user listed them as separate words (e.g. "banana orange milk" must be three items, not one).
- If the user lists two short produce items in a row without "and" or a comma (e.g. "bananas lime", "apples oranges milk"), split into separate items.
- Ignore filler ("please", "I need").

Examples:
- "banana orange mandarin green apples cilantro" → {"items":["banana","orange","mandarin","green apples","cilantro"]}
- "organic banana" → {"items":["organic banana"]}
- "whole wheat bread" → {"items":["whole wheat bread"]}
- "bread milk eggs" → {"items":["bread","milk","eggs"]}
- "bananas lime" → {"items":["bananas","lime"]}`;
  const data = await openAIChat(env, {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: transcript },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("no_content");
  return parseVoiceItemsJSON(content);
}

export async function openAIGroceryCategory(env: Env, productName: string): Promise<string> {
  const allowed = ["produce", "dairy", "meat", "frozen", "bakery", "pantry", "other"];
  const allowedStr = allowed.join(", ");
  const system = `You classify ONE grocery product into ONE store-aisle bucket for a shopping app.
Return ONLY compact JSON: {"category":"..."}.
The category string MUST be exactly one of: ${allowedStr}.
Examples:
- "tomatoes" → produce
- "2% milk" → dairy
- "ground beef" → meat
- "frozen peas" → frozen
- "frozen pizza" → frozen
- "bagels" → bakery
- "everything bagels" → bakery
- "olive oil" → pantry
- "coffee" → pantry
- "batteries" → other`;
  const data = await openAIChat(env, {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: productName },
    ],
    temperature: 0.1,
    response_format: { type: "json_object" },
  });
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("no_content");
  return parseCategoryJSON(content, allowed);
}

export async function openAIReceiptLines(
  env: Env,
  base64: string,
  mime: string,
  tripItemNames: string[],
): Promise<Array<{ name: string; price: string | null }>> {
  const dataURL = `data:${mime};base64,${base64}`;
  const system = `You read store receipts from photos. Extract each product line with its price.
Return ONLY compact JSON: {"lines":[{"name":"Product name","price":"2.99"}]}.
Rules:
- Skip headers, store info, subtotals, tax-only lines, payment/tip/change lines, and loyalty balance lines.
- Include weighted items (lines with @, lb, kg, or price per weight) as product lines with the line total price when visible.
- Normalize prices to numeric strings only (no currency symbols), e.g. "2.99" not "$2.99".
- When trip items are provided, prefer matching those names when the receipt line clearly refers to the same product; still include other product lines on the receipt.`;
  const namesList = tripItemNames.join(", ");
  const userText = namesList.length
    ? `Trip items (for matching): ${namesList}. Extract all product lines and prices.`
    : "Extract all product lines and prices.";
  const data = await openAIChat(env, {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: dataURL } },
        ],
      },
    ],
    temperature: 0.1,
    response_format: { type: "json_object" },
  });
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("no_content");
  return parseReceiptLinesJSON(content);
}
