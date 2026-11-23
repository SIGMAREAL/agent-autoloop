export function run(
  command: string[],
  args: string[],
  content: string | Uint8Array,
  signal?: AbortSignal,
  timeout?: number,
): Promise<string>;
