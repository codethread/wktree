import { expect, test } from "bun:test";
import { RepositoryConfigSchema } from "../../src/schemas.ts";

const [copyPath, copyObject] = RepositoryConfigSchema.shape.copy.unwrap().element.options;
const fields = { entry: copyPath, from: copyObject.shape.from, to: copyObject.shape.to };

test.each([
	{ name: "empty string", field: "entry", value: "" },
	{ name: "absolute string", field: "entry", value: "/tmp/abs" },
	{ name: "home string", field: "entry", value: "~/secret" },
	{ name: "escaping string", field: "entry", value: "../escape" },
	{ name: "missing source", field: "from", value: undefined },
	{ name: "missing destination", field: "to", value: undefined },
	{ name: "empty source", field: "from", value: "" },
	{ name: "empty destination", field: "to", value: "" },
	{ name: "absolute destination", field: "to", value: "/tmp/.env" },
	{ name: "home destination", field: "to", value: "~/.env" },
	{ name: "leading home destination", field: "to", value: "~secret" },
	{ name: "escaping destination", field: "to", value: "../.env" },
] as const)("copy entry schema rejects $name #test-716", ({ field, value }) => {
	expect(fields[field].safeParse(value).success).toBe(false);
});

test.each([
	{ name: "a relative string", field: "entry", value: ".env" },
	{ name: "absolute source", field: "from", value: "/shared/.env" },
	{ name: "home source", field: "from", value: "~/shared/.env" },
	{
		name: "normalized destinations within the worktree",
		field: "to",
		value: ["nested/../.env", "./local.env"],
	},
] as const)("copy entry schema accepts $name", ({ field, value }) => {
	expect(fields[field].safeParse(value).success).toBe(true);
});
