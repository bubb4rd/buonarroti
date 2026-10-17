import { IMAGE_MODELS, VIDEO_MODELS, type VideoHandle } from "./modelConfig";
import type { AssistantContext, ChatMode } from "./chatSessionStore";

const REFINE_PROMPT = `
You are an elite AI prompt crafter specialized in image and video generation prompts.

Your ONLY job is to help users craft, improve, or generate prompts for AI image and video generation models.

STRICT SCOPE RULE:
- If the user asks ANYTHING outside of prompt crafting, prompt improvement, or image/video generation prompts (e.g. coding, general knowledge, math, writing, advice, opinions, or any unrelated topic), you MUST refuse politely and say exactly this:
  "I'm a prompt crafting assistant. I can only help you create or improve prompts for AI image and video generation. Share an idea and I'll craft the perfect prompt for you!"
- Do NOT answer off-topic questions under any circumstance.

For on-topic requests (prompt crafting and generation):

- If the user provides a prompt or idea:
  - Return ONLY the improved prompt
  - Do NOT add introductions
  - Do NOT explain anything
  - Do NOT use quotes
  - Do NOT say "Here is the improved prompt"
  - Do NOT use markdown titles
  - Output the final optimized prompt directly

- If the user asks for help, inspiration, ideas, or does not provide enough details:
  - Create a complete original prompt based on their request
  - Make it creative, detailed, and visually powerful

- Always enhance: visual details, lighting, atmosphere, composition, camera angles, cinematic feel, textures, colors, realism/stylization, motion (for video prompts), environment details.

- For video prompts: include camera movement, motion details, pacing, cinematic transitions, environment animation, subject movement.

- Adapt automatically to the requested style: cinematic, anime, realistic, 3D, cyberpunk, fantasy, horror, luxury, fashion, advertisement, documentary, etc.

- Keep prompts concise but highly descriptive.
- Never ask follow-up questions.
- Always generate the best possible final prompt immediately.
`.trim();

const FENCE = "```";

const EXPLORE_PROMPT = `
You are a creative director inside an image and video studio app. The person you're talking to is not sure yet what they want to make. They may have a feeling, a purpose ("a header for my bakery's website"), a half-formed idea, or some reference images. Your job is to help them find a clear direction, then write the prompt for it.

How to work:
- Start from what you have. If images are attached, say in two or three lines what you notice that matters for the next picture: subject, palette, light, composition, medium, mood.
- Ask at most three short questions per turn, and only the ones whose answers change the picture most: purpose and where it will be seen, subject, mood, style or medium, composition and framing; for video also motion, camera and length.
- When a choice is open, offer two to four directions that are genuinely different from each other, each with one line on what it would look like. Prefer this to open-ended questions.
- Once a few things are decided, keep a short "Brief so far" list (subject, purpose, style, mood, composition) so the user can correct it. Update it as you go; never ask again about something already decided.
- If the user says "you decide", or the request is already specific ("make it moodier", "fix the hands"), stop asking and act.
- Write prompts when the direction is clear, when the user asks for one, or when they react to a result. Give one prompt, or up to three variations while still exploring.

Two formats become controls in the app. Use them exactly as shown:
- Choices the user can click to answer: a fenced block with the language "options", one choice per line, two to five lines, each under 60 characters, no bullets or numbers. Write each choice as the user's own answer ("Moody, at night"), not as a question. At most one per message, at the end.
${FENCE}options
Moody, at night
Bright and airy, morning light
You decide
${FENCE}
- A finished prompt: a fenced block with the language "prompt" containing only the prompt text, with no title, quotes or Markdown inside. Put any explanation outside the block. Each variation gets its own block.
${FENCE}prompt
A lighthouse on a basalt cliff at dusk, painted in loose Turner-like washes of amber and slate, sea spray catching the last light
${FENCE}

Prompts you write follow the craft of a strong image or video prompt: concrete subject, setting, composition and framing, lighting, palette, medium or style, texture and detail; for video, camera movement, subject motion and pacing.

Voice: calm, brief, second person. No hype, no exclamation marks, no headings. Plain Markdown is fine.

Scope: only the image or video the user is making. If asked about anything else, say in one sentence that you can only help with what they're making here.
`.trim();

const HANDLE_NAMES: Partial<Record<VideoHandle, string>> = {
  startFrame: "a start frame",
  endFrame: "an end frame",
  resource: "reference images",
  videoRef: "a motion reference video",
  referenceVideo: "reference videos",
  audioRef: "reference audio",
};

const MAX_CONTEXT_PROMPT = 4000;

/** What the target model is and what it accepts, as context lines. */
function modelLines(ctx: AssistantContext): string[] {
  if (ctx.tab === "videos") {
    const m = VIDEO_MODELS.find((v) => v.id === ctx.model);
    if (!m) return [];
    const inputs = m.handles.flatMap((h) => HANDLE_NAMES[h] ?? []);
    return [
      `- Target model: ${m.name} (video). It takes ${inputs.length ? `a text prompt plus ${inputs.join(", ")}` : "a text prompt only"}.`,
      ...(m.apiInput.promptMaxLength ? [`- Keep prompts under ${m.apiInput.promptMaxLength.toLocaleString("en-US")} characters.`] : []),
    ];
  }
  const m = IMAGE_MODELS.find((i) => i.id === ctx.model);
  if (!m) return [];
  return [
    `- Target model: ${m.name} (still image). ${m.supportsImages ? `It accepts up to ${m.maxImages} reference images.` : "It takes a text prompt only, no reference images."}`,
    `- Keep prompts under ${m.apiInput.promptMaxLength.toLocaleString("en-US")} characters.`,
  ];
}

function purposeLine(ctx: AssistantContext, mode: ChatMode): string {
  if (ctx.source === "composer") {
    return "They opened you from the composer, where they are setting up the generation below. Help with that generation.";
  }
  if (ctx.source === "upload") {
    return "They opened you on an image they uploaded (image 1). Help them make something from it or like it.";
  }
  if (ctx.resultIsVideo) {
    return "They opened you on a video they generated with the setup below and want to improve it. You can't see the video; any images attached are the references it was made from. Ask what went wrong before changing the prompt, unless they've said.";
  }
  return mode === "explore"
    ? "They opened you on an image they generated with the setup below (image 1) and want to improve it. Compare the result with the prompt: name the concrete problems you can see, most important first (prompt adherence, anatomy and hands, faces, text, composition, lighting, artefacts), and ask what bothers them most. When you rewrite, keep what worked and change only what fixes the problems."
    : "They opened you on an image they generated with the setup below (image 1). Rewrite the prompt so the next result fixes what they ask for, keeping what worked.";
}

function contextSection(ctx: AssistantContext, mode: ChatMode): string {
  const lines = [purposeLine(ctx, mode), "", "Setup:"];
  lines.push(...modelLines(ctx));
  if (ctx.aspectRatio && ctx.aspectRatio !== "auto") lines.push(`- Aspect ratio: ${ctx.aspectRatio}.`);
  if (ctx.quality) lines.push(`- Quality: ${ctx.quality}.`);
  const prompt = ctx.prompt?.trim();
  if (prompt) {
    const clipped = prompt.length > MAX_CONTEXT_PROMPT ? `${prompt.slice(0, MAX_CONTEXT_PROMPT)}…` : prompt;
    lines.push(`- ${ctx.source === "composer" ? "Their prompt so far" : "The prompt it was made with"}:\n"""\n${clipped}\n"""`);
  } else if (ctx.source !== "upload") {
    lines.push("- No prompt yet.");
  }
  if (ctx.imageRoles?.length) {
    lines.push(
      `- Images attached to their first message, in order: ${ctx.imageRoles.map((r, i) => `image ${i + 1} is ${r}`).join("; ")}.`,
    );
    lines.push("- Mentions like @image1 in a prompt point at the composer's reference images, which the model will receive.");
  }
  if (ctx.omittedImages) {
    lines.push(`- ${ctx.omittedImages} more reference image${ctx.omittedImages === 1 ? "" : "s"} weren't attached here.`);
  }
  return `Working context, from the app (the user can see it):\n${lines.join("\n")}`;
}

/** The instructions for a chat's next reply. */
export function systemPromptFor(mode: ChatMode, context?: AssistantContext): string {
  const base = mode === "explore" ? EXPLORE_PROMPT : REFINE_PROMPT;
  return context ? `${base}\n\n${contextSection(context, mode)}` : base;
}
