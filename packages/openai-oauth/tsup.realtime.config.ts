import { defineConfig } from "tsup"

export default defineConfig({
	entry: ["src/realtime-lab-client.ts"],
	format: ["esm"],
	platform: "browser",
	outDir: "dist/realtime",
	noExternal: ["@openai-oauth/core"],
})
