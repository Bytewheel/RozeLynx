# RozeLynx browser detection tables.
# Single source of truth for rozelynx-host (python3, parses this file)
# and open-external (sh, sources this file).
#
# Entry format: id|name|kind|commands...
#   kind: gui | cli
#   commands: space-separated executable names, tried in order with
#             `command -v`.
#
# Terminal entry format: id|name|exec_pattern|commands...
#   exec_pattern:
#     none   ->  "$term" CMD ARGS...
#     -e     ->  "$term" -e CMD ARGS...
#     --     ->  "$term" -- CMD ARGS...
#     start  ->  "$term" start -- CMD ARGS...
#     -e-sh  ->  "$term" -e sh -c 'exec "$0" "$@"' CMD ARGS...
#   Terminal preference order: $TERMINAL env var, x-terminal-emulator,
#   then this table top to bottom.

ROZELYNX_BROWSERS='firefox|Firefox|gui|firefox
librewolf|LibreWolf|gui|librewolf
floorp|Floorp|gui|floorp
waterfox|Waterfox|gui|waterfox
chrome|Google Chrome|gui|google-chrome-stable google-chrome chromium chromium-browser
brave|Brave|gui|brave-browser brave
vivaldi|Vivaldi|gui|vivaldi-stable vivaldi
edge|Microsoft Edge|gui|microsoft-edge-stable microsoft-edge
opera|Opera|gui|opera
qutebrowser|qutebrowser|gui|qutebrowser
falkon|Falkon|gui|falkon
konqueror|Konqueror|gui|konqueror
epiphany|GNOME Web|gui|epiphany
min|Min|gui|min
palemoon|Pale Moon|gui|palemoon pale-moon
lynx|Lynx|cli|lynx
w3m|w3m|cli|w3m
links|Links|cli|links
links2|Links 2|cli|links2
elinks|ELinks|cli|elinks
browsh|Browsh|cli|browsh
netsurf|NetSurf|cli|netsurf netsurf-gtk
'

ROZELYNX_TERMINALS='x-terminal-emulator|x-terminal-emulator|-e|x-terminal-emulator
kitty|Kitty|--|kitty
alacritty|Alacritty|-e|alacritty
foot|foot|none|foot
wezterm|WezTerm|start|wezterm
konsole|Konsole|-e|konsole
gnome-terminal|GNOME Terminal|-e|gnome-terminal
xfce4-terminal|Xfce Terminal|-e|xfce4-terminal
terminator|Terminator|-e|terminator
st|st|-e-sh|st
xterm|xterm|-e-sh|xterm
urxvt|rxvt-unicode|-e-sh|urxvt
'

rozelynx_which() {
	command -v -- "$1" 2>/dev/null || return 1
}

# first_found <space-separated commands> -> prints first command on PATH
rozelynx_first_found() {
	local cmd
	for cmd in $1; do
		if rozelynx_which "$cmd" >/dev/null; then
			echo "$cmd"
			return 0
		fi
	done
	return 1
}

# rozelynx_browser_entry <id> -> prints "name|kind|commands" or nothing
rozelynx_browser_entry() {
	printf '%s\n' "$ROZELYNX_BROWSERS" | awk -F'|' -v want="$1" '
		NF >= 4 && $1 == want { printf "%s|%s|%s\n", $2, $3, $4; found = 1; exit }
		END { exit !found }'
}

# rozelynx_found_browsers -> prints "id|name|kind" for each installed browser
rozelynx_found_browsers() {
	printf '%s\n' "$ROZELYNX_BROWSERS" | while IFS='|' read -r id name kind commands; do
		[ -n "$id" ] && [ -n "$commands" ] || continue
		if rozelynx_first_found "$commands" >/dev/null; then
			printf '%s|%s|%s\n' "$id" "$name" "$kind"
		fi
	done
}

# rozelynx_terminal_entry <id> -> prints "name|exec_pattern|commands" or nothing
rozelynx_terminal_entry() {
	printf '%s\n' "$ROZELYNX_TERMINALS" | awk -F'|' -v want="$1" '
		NF >= 4 && $1 == want { printf "%s|%s|%s\n", $2, $3, $4; found = 1; exit }
		END { exit !found }'
}

# Prints the id of the preferred available terminal (empty if none).
# Order: $TERMINAL env (only if it matches a known entry AND is executable),
# x-terminal-emulator, then table order.
rozelynx_preferred_terminal() {
	local basename
	if [ -n "${TERMINAL:-}" ] && rozelynx_which "$TERMINAL" >/dev/null; then
		basename=$(basename -- "$TERMINAL" 2>/dev/null)
		printf '%s\n' "$ROZELYNX_TERMINALS" | awk -v t="$basename" -v b="$TERMINAL" -F'|' '
			NF >= 4 {
				split($4, cmds, " ")
				for (i in cmds)
					if (cmds[i] == t || cmds[i] == b) { print $1; exit }
			}'
		return 0
	fi
	printf '%s\n' "$ROZELYNX_TERMINALS" | awk -F'|' 'NF >= 4 {
		split($4, cmds, " ")
		for (i in cmds)
			if (system("command -v -- \"" cmds[i] "\" >/dev/null 2>&1") == 0) {
				print $1
				exit
			}
	}'
	return 0
}

# rozelynx_terminal_launch <term_id> <browser_cmd> <url>
# Launches a CLI browser in the given terminal (nohup, detached).
# Honour BROWSER_FAKE=1 for tests: log instead of launching.
rozelynx_terminal_launch() {
	local tid=$1 cmd=$2 url=$3
	local name pattern commands bin term_bin
	local entry
	entry=$(rozelynx_terminal_entry "$tid")
	[ -n "$entry" ] || return 1
	name=${entry%%|*}; entry=${entry#*|}
	pattern=${entry%%|*}; commands=${entry#*|}
	term_bin=$(rozelynx_first_found "$commands")
	[ -n "$term_bin" ] || return 1

	if [ "${BROWSER_FAKE:-0}" = "1" ]; then
		rozelynx_log "FAKE cli[$tid]: $term_bin ($pattern) -> $cmd $url"
		return 0
	fi
	rozelynx_log "cli[$tid]: $term_bin ($pattern) -> $cmd $url"
	case "$pattern" in
		none)  nohup "$term_bin" "$cmd" "$url" >/dev/null 2>&1 & ;;
		-e)    nohup "$term_bin" -e "$cmd" "$url" >/dev/null 2>&1 & ;;
		--)    nohup "$term_bin" -- "$cmd" "$url" >/dev/null 2>&1 & ;;
		start) nohup "$term_bin" start -- "$cmd" "$url" >/dev/null 2>&1 & ;;
		-e-sh) nohup "$term_bin" -e sh -c 'exec "$0" "$@"' "$cmd" "$url" >/dev/null 2>&1 & ;;
		*) return 1 ;;
	esac
	return 0
}

ROZELYNX_LOG=/tmp/rozelynx-open-external.log

rozelynx_log() {
	printf '%s %s\n' "$(date '+%F %T')" "$*" >>"${ROZELYNX_LOG}" 2>/dev/null
}

# Dialog tools, preference order. Used by open-external to let the user pick
# a browser when no specific one was requested.
ROZELYNX_DIALOG_TOOLS="zenity qarma yad kdialog"

# rozelynx_show_chooser <url> -> prints a browser id on stdout
# ("" if the user cancelled). Shows a native list dialog with
# "Default browser", detected GUI browsers and CLI browsers (with their
# terminal). ROZELYNX_PICK bypasses the dialog for tests/automation.
#
# The browser id is embedded in the visible label as "[id]" because some
# zenity versions mishandle --print-column combined with --hide-column.
# Both dialog backends print the visible text; the trailing [id] is
# extracted below, so no hidden/printed-column trickery is needed.
rozelynx_show_chooser() {
	local url=$1
	local tool
	tool=$(rozelynx_first_found "$ROZELYNX_DIALOG_TOOLS")

	if [ -n "${ROZELYNX_PICK:-}" ]; then
		echo "$ROZELYNX_PICK"
		return 0
	fi
	if [ -z "$tool" ]; then
		rozelynx_log "no dialog tool found, using default browser"
		echo default
		return 0
	fi

	local rows="Default browser [default]"
	local id name kind tid tname
	while IFS='|' read -r id name kind; do
		[ -n "$id" ] || continue
		if [ "$kind" = "cli" ]; then
			tid=$(rozelynx_preferred_terminal)
			tname=$(rozelynx_terminal_entry "$tid" | awk -F'|' '{print $1}')
			[ -n "$tname" ] || tname="$tid"
			rows=$(printf '%s\n%s (%s) [%s]' "$rows" "$name" "$tname" "$id")
		else
			rows=$(printf '%s\n%s [%s]' "$rows" "$name" "$id")
		fi
	done <<EOF
$(rozelynx_found_browsers)
EOF

	local picked=""
	rozelynx_log "chooser: showing $tool dialog"
	if [ "${tool##*/}" = "kdialog" ]; then
		local pairs="" line
		while read -r line; do
			[ -n "$line" ] || continue
			pairs="$pairs \"${line% *}\" ${line##* }"
		done <<EOF
$(printf '%s\n' "$rows")
EOF
		picked=$(eval "kdialog --menu 'Open in external browser' --title RozeLynx $pairs" 2>/dev/null)
	else
		picked=$(printf '%s\n' "$rows" | "$tool" --list \
			--title="Open in external browser" \
			--text="$url" \
			--width=380 --height=440 \
			--column="Browser" 2>/dev/null)
	fi

	[ -n "$picked" ] || return 0

	# The selection carries the id as a trailing "[id]" token.
	id=$(printf '%s\n' "$picked" | sed -n 's/.*\[\([^][]*\)\][[:space:]]*$/\1/p')
	[ -n "$id" ] && echo "$id" || echo default
}
