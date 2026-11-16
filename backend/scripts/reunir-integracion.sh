#!/usr/bin/env bash
# Reúne, SOLO por la API de GitHub, los datos que necesita la política de integración (fase 5). No ejecuta nada del PR.
# Entradas (env): REPO, HEAD_BRANCH, HEAD_SHA, MODO, PROPIETARIO, AUTOR_ISSUES, POLITICA (ruta), OUT (ruta de salida).
# Cualquier fallo de la API termina con error: sin datos completos no hay decisión (falla cerrado).
set -euo pipefail
: "${REPO:?}" "${HEAD_BRANCH:?}" "${HEAD_SHA:?}" "${POLITICA:?}" "${OUT:?}"
MODO="${MODO:-}"; PROPIETARIO="${PROPIETARIO:-}"; AUTOR_ISSUES="${AUTOR_ISSUES:-}"

[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "commit no válido" >&2; exit 1; }
[[ "$HEAD_BRANCH" =~ ^agente/incidente-[0-9]{1,9}$ ]] || { echo "rama no válida" >&2; exit 1; }
NUM_ISSUE="${HEAD_BRANCH#agente/incidente-}"
ETIQUETA=$(jq -r '.etiquetaDisparador' "$POLITICA")

PR_NUM=$(gh api "repos/$REPO/commits/$HEAD_SHA/pulls" | jq -r --arg b "$HEAD_BRANCH" '[.[] | select(.head.ref==$b and .state=="open")] | first | .number // empty')
[ -n "$PR_NUM" ] || { echo "no hay un PR abierto para ese commit y rama" >&2; exit 1; }

PR=$(gh api "repos/$REPO/pulls/$PR_NUM")
FILES=$(gh api --paginate "repos/$REPO/pulls/$PR_NUM/files" --jq '.[]' | jq -s '.')
ISSUE=$(gh api "repos/$REPO/issues/$NUM_ISSUE")
EVENTOS=$(gh api --paginate "repos/$REPO/issues/$NUM_ISSUE/events" --jq '.[]' | jq -s '.')
CHECKS=$(gh api --paginate "repos/$REPO/commits/$HEAD_SHA/check-runs" --jq '.check_runs[]' | jq -s '.')
INTEGRADOS=$(gh pr list --repo "$REPO" --state merged --limit 100 --json headRefName,mergedAt \
  | jq '[.[] | select((.headRefName | startswith("agente/")) and ((.mergedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) > (now - 86400)))] | length')

jq -n \
  --arg modo "$MODO" --arg propietario "$PROPIETARIO" --arg autorIssues "$AUTOR_ISSUES" --arg repo "$REPO" --arg etiqueta "$ETIQUETA" \
  --argjson pr "$PR" --argjson files "$FILES" --argjson issue "$ISSUE" --argjson eventos "$EVENTOS" --argjson checks "$CHECKS" --argjson integrados "$INTEGRADOS" '
  {
    modo: $modo, propietario: $propietario, autorIssues: $autorIssues, repo: $repo,
    pr: { numero: $pr.number, base: $pr.base.ref, headRef: $pr.head.ref, headRepo: ($pr.head.repo.full_name // ""), draft: $pr.draft,
          autor: $pr.user.login, headSha: $pr.head.sha, cambiados: $pr.changed_files, abierto: ($pr.state == "open" and ($pr.merged | not)) },
    archivos: [ $files[] | { filename, status, additions, deletions, previous_filename, patch } ],
    issue: { numero: $issue.number, esPr: ($issue | has("pull_request")), autor: $issue.user.login, etiquetas: [ $issue.labels[].name ],
             etiquetadoPor: ([ $eventos[] | select(.event == "labeled" and .label.name == $etiqueta) ] | last | .actor.login // null) },
    checks: [ $checks[] | { nombre: .name, conclusion: .conclusion, sha: .head_sha } ],
    integradosHoy: $integrados
  }' > "$OUT"
