/** Package a Nix MCP with the same artifact contract as bundled runtimes. */
import { fileURLToPath } from "node:url";
import type { NixMcpSource } from "../../core/src/mcp-config.ts";

export const nixString = (value: string): string => JSON.stringify(value).replaceAll("${", "\\${");

/** All user values enter Nix through JSON data, never executable expressions. */
export const mcpBuildExpression = (spec: {
  ref: string;
  nixpkgs: string;
  system: string;
  attribute: string;
  helper: string;
  executable: string;
  args: string[];
}): string => `
let
  spec = builtins.fromJSON ${nixString(JSON.stringify(spec))};
  upstream = builtins.getFlake spec.ref;
  pkgs = import (builtins.getFlake spec.nixpkgs).outPath { system = spec.system; };
  path = pkgs.lib.splitString "." spec.attribute;
  candidates = [
    ([ "packages" spec.system ] ++ path)
    ([ "legacyPackages" spec.system ] ++ path)
    path
  ];
  selected = pkgs.lib.findFirst (p: pkgs.lib.hasAttrByPath p upstream)
    (throw "MCP package output not found for ${spec.system}") candidates;
  package = pkgs.lib.getAttrFromPath selected upstream;
in (builtins.getFlake spec.helper).lib.mkRuntime { inherit pkgs package; inherit (spec) executable args; }
`;

export const nixMcpBuildArgs = async (
  source: NixMcpSource,
  checked: (command: string, args: string[]) => Promise<string>,
): Promise<string[]> => {
  const [ref, attribute = "default", ...extra] = source.ref.split("#");
  if (!ref || !attribute || extra.length) throw new Error("Invalid MCP flake reference");
  const metadata = JSON.parse(
    await checked("nix", [
      "--extra-experimental-features",
      "nix-command flakes",
      "flake",
      "metadata",
      "--json",
      "--no-write-lock-file",
      ref,
    ]),
  );
  if (!metadata.locked?.narHash || typeof metadata.url !== "string")
    throw new Error("Nix did not resolve the MCP source to an immutable reference");
  const lock = JSON.parse(await Deno.readTextFile(new URL("../../flake.lock", import.meta.url)));
  const pin = lock.nodes.nixpkgs.locked;
  if (pin.type !== "github" || !pin.rev) throw new Error("Unsupported Loom nixpkgs pin");
  const system = Deno.build.arch === "aarch64" ? "aarch64-linux" : "x86_64-linux";
  const helper = fileURLToPath(new URL("../../packaging/runtimes", import.meta.url));
  const helperMetadata = JSON.parse(
    await checked("nix", [
      "--extra-experimental-features",
      "nix-command flakes",
      "flake",
      "metadata",
      "--json",
      "--no-write-lock-file",
      "path:" + helper,
    ]),
  );
  if (!helperMetadata.locked?.narHash || typeof helperMetadata.url !== "string")
    throw new Error("Nix did not resolve the Loom packaging helper");
  return [
    "--expr",
    mcpBuildExpression({
      ref: metadata.url,
      nixpkgs: `github:${pin.owner}/${pin.repo}/${pin.rev}`,
      system,
      attribute,
      helper: helperMetadata.url,
      executable: source.executable,
      args: source.args,
    }),
  ];
};
