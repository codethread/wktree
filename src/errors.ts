export const EXIT_CODES = {
	SUCCESS: 0,
	BLOCKED: 10,
	UNSAFE: 11,
	USAGE: 12,
	CANCELLED: 130,
	FAILURE: 1,
} as const;

export class WktreeError extends Error {
	constructor(
		message: string,
		public exitCode: number = EXIT_CODES.FAILURE,
	) {
		super(message);
		this.name = new.target.name;
	}
}

export class UsageError extends WktreeError {
	constructor(message: string) {
		super(message, EXIT_CODES.USAGE);
	}
}

export class BlockedError extends WktreeError {
	constructor(message: string) {
		super(message, EXIT_CODES.BLOCKED);
	}
}

export class UnsafeOperationError extends WktreeError {
	constructor(message: string) {
		super(message, EXIT_CODES.UNSAFE);
	}
}

export class ConfigError extends UsageError {}
export class PickerCancelled extends WktreeError {
	constructor() {
		super("cancelled", EXIT_CODES.CANCELLED);
	}
}
export class DuplicateBranchError extends BlockedError {}
export class DirtySlotError extends UnsafeOperationError {}
export class UnmergedBranchError extends UnsafeOperationError {}
export class DirtyCanonicalError extends BlockedError {}
export class DirtyWorktreeError extends BlockedError {}
export class WrongCanonicalBranchError extends BlockedError {}
export class NonFastForwardCanonicalError extends BlockedError {}
export class TargetNotFreshError extends BlockedError {}
export class FinishConflictError extends BlockedError {}
export class ReservedPrefixError extends UsageError {}
export class CanonicalRootError extends UnsafeOperationError {}
export class HookError extends WktreeError {
	constructor(
		public hookExitCode: number,
		public slotPath: string,
	) {
		super(`hook failed in ${slotPath} (${hookExitCode})`, EXIT_CODES.FAILURE);
	}
}
export class TrunkDetectionError extends UsageError {}
