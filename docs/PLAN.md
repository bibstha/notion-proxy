# notion-proxy Bun CLI 재구성 계획 (승인됨)

## 목표 (Why)
- `notion-proxy`를 MCP 전용 서버에서 **원자적·비대화형 CLI**로 바꾼다. npm에 배포하지 않고 `bunx github:kdm1jkm/notion-proxy <command>`로 실행한다.
- **좋은 CLI 관례**를 그대로 따른다. help와 오류 메시지는 사람이 읽고 이해할 수 있는 수준으로 쓰고, 그 결과 `bunx github:kdm1jkm/notion-proxy help` 하나만 프롬프트에 넣어도 AI가 사용법을 파악해 실행할 수 있게 한다. AI 전용 문구나 섹션은 따로 두지 않는다.
- 기존 MCP 사용 방식은 `mcp` 서브커맨드(stdio, 대화형)로 계속 지원한다.

## 확정된 결정
| 항목 | 결정 |
|---|---|
| 언어/런타임 | **TypeScript + Bun 전용**. Bun이 `.ts`를 직접 실행하므로 빌드 단계가 없다. shebang은 `#!/usr/bin/env bun`. Node·npx 지원은 **완전히 중단**한다. |
| 실행 경로 | `bunx github:kdm1jkm/notion-proxy`. 사용자가 GitHub 경로 bunx 실행이 동작하는 것을 확인했다. |
| 스키마/검증 | **Zod 미사용**. 명령 정의 타입과 파서·검증을 직접 구현한다. |
| MCP SDK | **미사용, 직접 구현**한다 (아래 근거 참조). |
| 출력 | 기본은 사람이 읽는 텍스트. 전역 옵션 **`--json`** 을 지원한다. |
| help 언어 | **영어** |
| SQLite | `better-sqlite3`를 `bun:sqlite`로 교체한다. |
| 런타임 의존성 | **0개**. `devDependencies`는 타입 검사용 `typescript`, `@types/bun`만 둔다. |

### MCP SDK를 쓰지 않는 근거
- `@modelcontextprotocol/sdk@1.29.0`은 `zod`를 dependency와 peerDependency로 요구한다. Zod를 쓰지 않는다는 결정과 충돌한다.
- 이 SDK는 `express`, `hono`, `ajv`, `jose`, `cors`, `eventsource` 등 17개 패키지를 함께 끌고 온다. 대부분 HTTP 전송과 OAuth용이라 stdio 도구 서버에는 필요 없다.
- 필요한 범위는 줄 단위 JSON-RPC 2.0과 `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`뿐이다. 약 100~150줄로 구현할 수 있다.
- 기준 프로토콜 버전: SDK 1.29.0이 지원하는 `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. 클라이언트가 요청한 버전이 이 목록에 있으면 그대로 돌려주고, 없으면 `2025-06-18`을 돌려준다.

## 하지 않을 것 (Out of scope)
- npm 레지스트리 배포
- Node·npx 호환, 빌드·번들 산출물
- Firefox 외 브라우저(Chrome 등)의 쿠키 자동 로드. 기존 Firefox와 `NOTION_COOKIE` 방식만 유지한다.
- 새 Notion 기능 추가. 기존 도구 8개만 그대로 옮긴다.
- MCP의 HTTP/SSE 전송, resources/prompts, OAuth
- 대화형 프롬프트, 확인 질문, TUI, 색상 출력
- 셸 자동완성, 설정 파일

## 파일 구조
```
bin/notion-proxy.ts   진입점: argv 분기, 전역 옵션, 종료 코드
src/notion.ts         Notion 내부 API (server.mjs의 쿠키·요청·렌더링 로직을 이전)
src/commands.ts       명령 정의 테이블 (단일 출처)
src/args.ts           명령 정의 기반 argv 파서와 검증 (node:util parseArgs 사용 가능)
src/help.ts           명령 정의로 help 텍스트 생성
src/mcp.ts            stdio JSON-RPC MCP 서버
```
- `server.mjs`, `package-lock.json`, `pi-mcp-adapter`, `@modelcontextprotocol/sdk`, `better-sqlite3`를 삭제한다.
- `package.json`:
  - `"type": "module"`
  - `"bin": { "notion-proxy": "./bin/notion-proxy.ts" }`
  - `"scripts": { "check": "tsc --noEmit" }`
- `tsconfig.json`: Bun 권장 설정을 쓰고 `strict`를 켠다.
- `.env.example`을 유지한다.

## 명령 정의 (단일 출처)
명령마다 다음 항목을 선언한다. 이 정의 하나로 CLI 파싱, help, MCP `inputSchema`, `--json` 출력을 모두 만든다.
실제 정의는 `src/commands.ts`의 `Command`, `Arg`, `Option` 타입을 따른다.
```ts
interface Command {
  name: string;                 // CLI 명령명이자 MCP 도구명 (기존 kebab-case 이름 유지)
  summary: string;              // 명령 목록에 쓰는 한 줄 설명
  description: string;          // help <cmd> 본문이자 MCP 도구 설명
  args: Arg[];                  // 위치 인자(모두 필수): name, label?, description
  options: Option[];            // 문자열 옵션: name, short?, value, description, required?, choices?, default?, stdin?
  output: string;               // 텍스트 출력 설명
  json: string;                 // --json 출력 형태 설명
  examples: string[];
  run(input): Promise<Result>;  // Result = { text: string; json: unknown }
}
```
- MCP에서는 위치 인자와 옵션을 모두 JSON 속성으로 노출한다. 속성 이름은 기존 MCP 이름과 맞춘다(`page`, `block_id`, `discussion_id`, `text`, `type`, `language`, `after`, `property`, `source`, `parent`, `title`). CLI 쪽은 kebab-case 플래그로 노출한다(`--discussion-id`).
- `inputSchema`는 `{ type: "object", properties: { ... }, required: [...] }` 형태로 만든다. `choices`가 있으면 `enum`, `default`가 있으면 `default`를 붙인다.

## 명령 목록 (기존 도구 8개를 그대로 이전)
| 명령 | 위치 인자 | 옵션 | 텍스트 출력 | `--json` 출력 |
|---|---|---|---|---|
| `read-page` | `<page>` | | Markdown (`[block:<id>]` 포함) | `{ page_id, markdown }` |
| `read-comments` | `<page>` | | 토론과 댓글 텍스트 | `{ page_id, discussions: [{ id, parent_block_id, context, resolved, comments: [{ id, author, created_time, text }] }] }` |
| `add-comment` | `<page>` | `-t/--text` (필수, `-`이면 stdin), `--discussion-id` | 댓글·토론 ID | `{ discussion_id, comment_id }` |
| `add-block` | `<page>` | `-t/--text` (필수, stdin 가능), `--type`, `--language`, `--after` | 새 블록 ID | `{ block_id }` |
| `edit-block` | `<block>` | `-t/--text` (필수, stdin 가능), `--property` | `updated <id>` | `{ block_id }` |
| `delete-block` | `<block>` | | `deleted <id>` | `{ block_id }` |
| `add-image` | `<page> <source>` | `--after` | 새 블록 ID | `{ block_id, source }` |
| `create-page` | `<parent>` | `--title` (필수), `--after` | 새 페이지 ID와 URL | `{ page_id, url }` |
| `mcp` | | | stdio MCP 서버 실행 | 해당 없음 |
| `help` | `[command]` | | help 텍스트 | 해당 없음 |

- `--json`을 쓰지 않을 때 쓰기 명령은 다음 명령에 바로 넘길 수 있는 ID를 한 줄로 출력한다.
- 반환 필드는 기존 함수가 실제로 돌려주는 값 안에서 정한다. 필드를 얻을 수 없으면 표의 키를 줄이고, 이 문서와 help도 함께 고친다.

## CLI 관례
- `help`, `help <cmd>`, `<cmd> -h/--help`, `-h/--help`, `--version`, `-V`를 지원한다.
- 인자 없이 실행하면 최상위 help를 stderr에 출력하고 종료 코드 2로 끝낸다.
- 전역 옵션은 `--json`이다. 명령 앞이나 뒤 어디에 와도 인식한다.
- `-`는 stdin을 뜻한다. stdin을 받는 옵션은 `-t, --text`뿐이다.
- stdout에는 결과만, stderr에는 오류만 쓴다. MCP 모드에서는 stdout에 JSON-RPC 메시지만 쓴다.
- 종료 코드: `0` 성공, `1` 실행 오류(인증, Notion API, 권한, 네트워크), `2` 사용법 오류.
- 대화형 입력은 절대 받지 않는다.

## help와 오류 메시지
- 최상위 help 섹션: 한 줄 소개, `Usage`, `Commands`, `Arguments`(page·block ID를 얻는 법), `Global options`, `Authentication`, `Examples`, `Exit status`, `Run 'notion-proxy help <command>'` 안내.
- 명령별 help 섹션: `Usage`, 설명, `Arguments`, `Options`(허용 값과 기본값 표시), `Output`, `Examples`.
- 사용법 오류는 git 스타일로 출력한다:
  ```
  notion-proxy add-block: missing required option --text
  Usage: notion-proxy add-block <page> --text <text> [options]
  Run 'notion-proxy help add-block' for details.
  ```
- 알 수 없는 명령이면 가장 가까운 명령을 제안한다(`Did you mean 'read-page'?`).
- 실행 오류는 원인과 다음 할 일을 같이 쓴다. 예:
  - 쿠키 없음: 확인한 Firefox 프로필 경로와 `NOTION_COOKIE` 설정 방법
  - 401/403: 세션 만료 또는 해당 페이지 권한 부족
  - 잘못된 ID: 허용하는 URL·UUID 형식
- `--json`을 쓰면 오류도 stderr에 `{ "error": { "code": "usage" | "auth" | "notion" | "network", "message": "...", "hint": "..." } }` 형식으로 출력한다. 종료 코드는 동일하다.

## MCP 동작
- 줄 단위 JSON-RPC 2.0으로 stdin을 읽고 stdout에 쓴다.
- `tools/list`: 명령 정의에서 만든 `name`, `description`, `inputSchema`를 돌려준다. `mcp`와 `help`는 제외한다.
- `tools/call`: 인자를 같은 검증기로 확인한 뒤 `run`을 호출한다.
  - 성공 시 `{ content: [{ type: "text", text }] }`를 돌려준다.
  - 실행 오류는 `isError: true`로 돌려준다.
  - 알 수 없는 도구나 잘못된 인자는 JSON-RPC 오류 `-32602`로 돌려준다.
- 알 수 없는 메서드는 `-32601`, JSON 파싱 실패는 `-32700`으로 돌려준다. 알림(`id` 없음)에는 응답하지 않는다.

## README
- bunx 사용법, `#<tag>`로 버전을 고정하는 방법을 넣는다. bunx가 캐시된 이전 버전을 실행할 수 있다는 점은 아직 추정이다.
- MCP 등록 예시: `{ "command": "bunx", "args": ["github:kdm1jkm/notion-proxy", "mcp"], "type": "stdio" }`
- 실제 OS 지원 범위(macOS·Linux·Windows의 Firefox 경로)를 적고, 기존의 "macOS 전용" 문구를 삭제한다.

## 검증 (구현 후)
1. `bun run check`가 통과해야 한다.
2. `help`, `help <cmd>`, `-h`, 인자 없음, 알 수 없는 명령, 필수 옵션 누락 각각에서 출력 위치(stdout/stderr)와 종료 코드가 맞아야 한다.
3. 테스트 Notion 페이지에서 8개 명령을 텍스트 모드와 `--json` 모드로 모두 실행한다.
4. `mcp`에 `initialize`, `tools/list`, `tools/call` JSON-RPC를 stdin으로 넣고 응답을 확인한다.
5. 빈 디렉터리에서 `bunx github:kdm1jkm/notion-proxy#<branch> help`를 Windows에서 실행한다. `.ts` bin이 정상 실행되는지도 함께 확인한다.
