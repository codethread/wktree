import {z} from "zod";

export const CopyModeSchema = z.enum(["copy", "symlink"]);
export const PoolSizeSchema = z.number().int().min(1);

export const ProjectTableSchema = z
	.object({
		name: z.string().optional(),
		root: z.string().min(1),
		command: z.string().min(1),
		pool_size: PoolSizeSchema.optional(),
		copy_mode_default: CopyModeSchema.optional(),
		copy: z.array(z.unknown()).optional(),
	})
	.passthrough();

export const TreesTomlSchema = z
	.object({
		project: z.array(z.unknown()).optional(),
	})
	.passthrough();
