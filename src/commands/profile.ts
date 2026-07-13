import { runProfileCommand } from "../provider-profile-service.js";

export async function profileCommand(args: string[]): Promise<number> {
  return runProfileCommand(args);
}
