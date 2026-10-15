# Brick shell integration for zsh. Sourced last from the generated .zshrc.
# Sends hooks to the terminal as: ESC P $ d <hex(JSON)> ESC \
[[ -n "$BRICK_BOOTSTRAPPED" ]] && return 0
export BRICK_BOOTSTRAPPED=1
typeset -gi _brick_count=0 _brick_running=0

_brick_hex() { print -rn -- "$1" | command od -An -v -tx1 | command tr -d ' \n' }

_brick_json_escape() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  s=${s//[[:cntrl:]]/ }
  print -rn -- "$s"
}

_brick_send() { printf '\eP$d%s\e\\' "$(_brick_hex "$1")" }

_brick_preexec() {
  _brick_running=1
  _brick_send "{\"hook\":\"Preexec\",\"value\":{\"command\":\"$(_brick_json_escape "$1")\",\"cwd\":\"$(_brick_json_escape "$PWD")\",\"session_id\":$BRICK_SESSION}}"
}

_brick_precmd() {
  local exit_code=$?   # must be first: $? is the status of the command that just ran
  (( _brick_count++ ))
  if (( _brick_running )); then
    _brick_running=0
    _brick_send "{\"hook\":\"CommandFinished\",\"value\":{\"exit_code\":$exit_code,\"next_block_id\":\"precmd-$BRICK_SESSION-$_brick_count\",\"session_id\":$BRICK_SESSION}}"
  fi
  _brick_send "{\"hook\":\"Precmd\",\"value\":{\"cwd\":\"$(_brick_json_escape "$PWD")\",\"session_id\":$BRICK_SESSION}}"
}

# Ours must run first so $? is untouched by other precmd hooks.
preexec_functions=(_brick_preexec $preexec_functions)
precmd_functions=(_brick_precmd $precmd_functions)
