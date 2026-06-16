def wk-session-name [path: string] {
	$path | path basename | str replace --all '.' '_'
}

# open a directory as a tmux session, or cd when outside tmux
export def --env wk-open-dir [
	path: string
	title: string
] {
	let created_path = ($path | path expand)
	let session_name = (wk-session-name $created_path)

	if "TMUX" in $env {
		print --stderr $"wk: target tmux session ($session_name)"
		let has_session = (tmux has-session -t $"=($session_name)" | complete)
		if $has_session.exit_code != 0 {
			print --stderr "wk: creating tmux session"
			tmux new-session -d -s $session_name -n $title -c $created_path
		} else {
			print --stderr "wk: reusing existing tmux session"
		}
		print --stderr "wk: switching tmux client"
		tmux switch-client -t $session_name
	} else {
		print --stderr $"wk: changing directory to ($created_path)"
		cd $created_path
	}
}

# close tmux sessions rooted at path
export def wk-close-dir [path: string] {
	if "TMUX" not-in $env { return }
	let target_path = ($path | path expand)
	let sessions = (tmux list-sessions -F "#{session_name}\t#{session_path}" | lines)
	for row in $sessions {
		let parsed = ($row | split row "\t")
		if ($parsed | length) < 2 { continue }
		let name = ($parsed | get 0)
		let session_path = ($parsed | get 1 | path expand)
		if $session_path == $target_path or ($session_path | str starts-with $"($target_path)/") {
			tmux kill-session -t $name
		}
	}
}
