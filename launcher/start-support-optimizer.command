#!/bin/bash
# ---------------------------------------------------------------
#  Support Optimizer - double-click launcher (macOS / Linux)
#
#  Starts a small local web server in this folder and opens the app
#  in your default browser. Nothing is installed; closing this
#  window (or Ctrl+C) stops the server again.
#
#  macOS: if double-clicking does nothing the first time, run
#    chmod +x "start-support-optimizer.command"
#  once in Terminal, then double-click again.
# ---------------------------------------------------------------

cd "$(dirname "$0")" || exit 1

if [ ! -f index.html ]; then
  echo
  echo "  ERROR: index.html was not found next to this launcher."
  echo "  Put this file in the same folder as index.html and assets/."
  echo
  read -r -p "Press Return to close." _
  exit 1
fi

PORT=8731
URL="http://localhost:$PORT"

open_browser() {
  sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  else echo "  Open $URL in your browser."
  fi
}

echo
echo "  Starting Support Optimizer on $URL"
echo "  Keep this window open while you use the app."
echo "  Close it (or press Ctrl+C) to stop."
echo

# Each candidate is tested by actually RUNNING it, not just by checking
# that the command exists: a command can be present but non-functional
# (macOS ships a "python3" stub that only prompts to install the Xcode
# command line tools, and Windows has the same problem with its Store
# alias for "python").
if python3 -c "pass" >/dev/null 2>&1; then
  open_browser &
  exec python3 -m http.server "$PORT"
elif python -c "pass" >/dev/null 2>&1; then
  open_browser &
  exec python -m http.server "$PORT"
elif node -e "0" >/dev/null 2>&1; then
  echo "  Using Node - the first run downloads a small helper, please wait..."
  open_browser &
  exec npx --yes serve . -l "$PORT"
else
  echo
  echo "  Neither Python nor Node.js was found on this computer."
  echo "  Install Node.js from https://nodejs.org (the LTS button),"
  echo "  then run this file again."
  echo
  read -r -p "Press Return to close." _
  exit 1
fi
