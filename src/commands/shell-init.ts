import { EXIT_CODES, UsageError } from "../errors.ts";
import type { CommandResult } from "../protocol.ts";

const EMPTY_COUNT = 0;

const ZSH_INIT = `# Fuzzy-pick a worktree and change the current shell's directory.
wk() {
	emulate -L zsh
	local cd_file target state_home
	state_home="\${XDG_STATE_HOME:-}"
	if [[ "$state_home" != /* ]]; then
		state_home="$HOME/.local/state"
	fi
	state_home="$state_home/wktree"
	command mkdir -p -- "$state_home" || return $?
	cd_file=$(command mktemp "$state_home/picker.XXXXXX") || return $?
	{
		WKTREE_CD_FILE="$cd_file" command wktree --interactive pick "$@" || return $?
		target="$(command cat -- "$cd_file"; printf '.')"
		target=\${target%.}
		if [[ -n "$target" ]]; then
			builtin cd -- "$target" || return $?
		fi
		return 0
	} always {
		command rm -f -- "$cd_file"
	}
}
`;

const NU_INIT = `# Fuzzy-pick a worktree and change the current shell's directory.
export def --env --wrapped wk [...args: string] {
	let configured_state = ($env.XDG_STATE_HOME? | default "")
	let state_root = if ($configured_state | str starts-with "/") {
		$configured_state
	} else {
		$env.HOME | path join ".local" "state"
	}
	let state_home = ($state_root | path join "wktree")
	mkdir $state_home
	let cd_file = (^mktemp ($state_home | path join "picker.XXXXXX") | str trim)
	try {
		with-env { WKTREE_CD_FILE: $cd_file } {
			^wktree --interactive pick ...$args
		}
		let target = (open --raw $cd_file)
		if $target != "" {
			cd $"($target)/"
		}
	} catch {|failure|
		rm --force $cd_file
		error make $failure
	}
	rm --force $cd_file
}
`;

/** Emit a picker function for shell configuration without inspecting a repository. */
export function shellInitCommand(args: string[]): CommandResult {
	const [shell, ...extra] = args;
	if (shell === undefined || extra.length !== EMPTY_COUNT) {
		throw new UsageError("shell-init requires one shell: zsh or nu");
	}
	return { exitCode: EXIT_CODES.SUCCESS, stdout: shellInitScript(shell) };
}
// --- Private functions ---

function shellInitScript(shell: string): string {
	switch (shell) {
		case "zsh": {
			return ZSH_INIT;
		}
		case "nu": {
			return NU_INIT;
		}
		default: {
			throw new UsageError(`unsupported shell: ${shell}; expected zsh or nu`);
		}
	}
}
