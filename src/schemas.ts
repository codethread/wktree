import {z} from "zod";

export const CopyModeSchema = z.enum(["copy", "symlink"]);
export const PoolSizeSchema = z.number().int().min(1);
