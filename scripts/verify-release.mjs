/* eslint-env node */
/* global console, process */
import { existsSync, readFileSync } from "fs";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
	return readFileSync(path, "utf8");
}

const packageJson = readJson("package.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");
const readme = readText("README.md");
const readmeZh = readText("README_zh.md");
const license = readText("LICENSE");

const checks = [];

function check(ok, label, detail = "") {
	checks.push({ ok, label, detail });
}

function includesAll(text, snippets) {
	return snippets.every((snippet) => text.includes(snippet));
}

check(existsSync("README.md"), "README.md exists");
check(existsSync("README_zh.md"), "README_zh.md exists");
check(existsSync("LICENSE"), "LICENSE exists");
check(existsSync("manifest.json"), "manifest.json exists");
check(existsSync("package-lock.json"), "package-lock.json exists");

check(
	packageJson.version === manifest.version,
	"package.json version matches manifest.json",
	`${packageJson.version} vs ${manifest.version}`
);

check(
	versions[manifest.version] === manifest.minAppVersion,
	"versions.json contains current release mapping",
	`${manifest.version} -> ${versions[manifest.version] ?? "missing"}`
);

check(
	/^\d+\.\d+\.\d+$/.test(manifest.version),
	"manifest version uses x.y.z format",
	manifest.version
);

check(
	/^[a-z-]+$/.test(manifest.id) && !manifest.id.endsWith("plugin") && !manifest.id.includes("obsidian"),
	"manifest id satisfies Obsidian rules",
	manifest.id
);

check(
	packageJson.license === "GPL-3.0-only",
	"package.json license is aligned",
	packageJson.license
);

check(
	license.includes("GNU GENERAL PUBLIC LICENSE"),
	"LICENSE content looks like GPL"
);

check(
	includesAll(readme, [
		"## 🔒 Privacy and disclosures",
		"No account required",
		"No telemetry or ads",
		"Network use",
		"External file access"
	]),
	"README.md contains disclosures"
);

check(
	includesAll(readmeZh, [
		"## 🔒 隐私与披露",
		"无需账号",
		"无遥测、无广告",
		"网络访问",
		"外部文件访问"
	]),
	"README_zh.md contains disclosures"
);

check(
	!existsSync("main.js"),
	"main.js is not committed in repo root"
);

const failed = checks.filter((item) => !item.ok);

for (const item of checks) {
	const icon = item.ok ? "✅" : "❌";
	const suffix = item.detail ? ` — ${item.detail}` : "";
	console.log(`${icon} ${item.label}${suffix}`);
}

if (failed.length > 0) {
	console.error(`\nRelease verification failed: ${failed.length} issue(s) found.`);
	process.exit(1);
}

console.log("\nRelease verification passed.");
