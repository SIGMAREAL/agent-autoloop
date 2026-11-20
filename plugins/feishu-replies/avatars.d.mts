export class Avatars {
  constructor(options: {
    stateDir?: string;
    profile: string;
    scope: string;
    command: string[];
    signal: AbortSignal;
    log(line: string): void;
  });
  resolve(url: string): Promise<string | null>;
}
