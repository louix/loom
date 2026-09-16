import { basename } from "node:path";
import { makePicker, type Picker } from "./overlay.ts";

export const repositoryPicker = (repositories: string[], current?: string): Picker =>
  makePicker({
    step: "repository",
    dest: { t: "repository" },
    title: "Switch repository",
    emptyText: "No recent repositories. Run loom from a Git repository, or use loom --repo <path>.",
    items: repositories.map((path) => ({
      id: path,
      label: basename(path),
      hint: path === current ? `${path} (current)` : path,
      blob: path,
    })),
  });
