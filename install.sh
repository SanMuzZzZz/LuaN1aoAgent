#!/usr/bin/env bash
# LuaN1aoAgent one-click setup:
#   1. Install the recommended skill collections (pentest-skills,
#      awesome-skills-security, ctf-skills) into ./.agents/skills/
#      (project-local skills directory)
#   2. npm ci && npm run build
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_SKILLS_DIR="${PROJECT_ROOT}/.agents/skills"
SKILLS_REPOS=(
  "https://github.com/crazyMarky/pentest-skills.git"
  "https://github.com/Eyadkelleh/awesome-skills-security.git"
  "https://github.com/ljagiello/ctf-skills.git"
)

log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 25+ is required (node not found)" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 25 ]; then
  echo "Node.js 25+ is required (found $(node --version)); the runtime needs node:sqlite." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
mkdir -p "${AGENTS_SKILLS_DIR}"

# Clone one collection and copy every skill (directory holding a SKILL.md)
# into ./.agents/skills/.
install_skills() {
  local repo="$1"
  local name
  name="$(basename "${repo}" .git)"
  log "Cloning ${repo}"
  rm -rf "${TMP_DIR}/${name}"
  git clone --quiet --depth 1 "${repo}" "${TMP_DIR}/${name}"

  local count=0 skill_md skill_dir skill_name
  while IFS= read -r skill_md; do
    skill_dir="$(dirname "${skill_md}")"
    skill_name="$(basename "${skill_dir}")"
    rm -rf "${AGENTS_SKILLS_DIR:?}/${skill_name}"
    cp -R "${skill_dir}" "${AGENTS_SKILLS_DIR}/${skill_name}"
    count=$((count + 1))
  done < <(find "${TMP_DIR}/${name}" -maxdepth 3 -name SKILL.md \
    -not -path "*/.git/*" -not -path "*/scripts/*" \
    -not -path "*/tests/*" -not -path "*/docs/*" -not -path "*/templates/*")
  log "Installed ${count} skills from ${name} into .agents/skills/"
}

# 1. Recommended skill collections.
for REPO in "${SKILLS_REPOS[@]}"; do
  install_skills "${REPO}"
done

# 2. Dependencies and build.
log "Running npm ci"
npm ci --prefix "${PROJECT_ROOT}"
log "Running npm run build"
npm run build --prefix "${PROJECT_ROOT}"

log "Done. Start a run with: npm start -- --goal \"...\" --scope \"...\""
