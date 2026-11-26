/**
 * Skill 加载：把一组「指令 + 可选脚本」打包成可复用能力。
 *
 * 为什么需要 Skill 这一层（而不是把所有指令都塞进 system prompt）：
 *   1. 上下文预算有限。100 个工具的描述塞不进窗口，按需加载才行。
 *   2. 可组合。同一个「订单查询」技能，客服 Agent 和运营 Agent 都能用。
 *   3. 可版本化。技能是文件，改它等于改 prompt，能被 git 追踪。
 *
 * 格式（与 agentskills.io 的 SKILL.md 约定一致）：
 *   my-skill/
 *     SKILL.md        # 头部 frontmatter + 正文指令
 *     scripts/*.mjs   # 可选，声明式脚本
 *
 *   ---
 *   name: order-lookup
 *   description: 查询订单状态与物流（什么时候该用）
 *   tools: [query_order, query_logistics]
 *   ---
 *
 *   正文：给模型的执行指令……
 */
import fs from 'node:fs';
import path from 'node:path';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * 解析一个 SKILL.md。
 * @param {string} file
 * @returns {{name:string, description:string, tools:string[], instructions:string, dir:string, meta:object}|null}
 */
export function parseSkillFile(file) {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(FRONTMATTER);
    if (!m) return null;
    const meta = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (!kv) continue;
        let v = kv[2].trim();
        if (v.startsWith('[') && v.endsWith(']')) {
            v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        }
        meta[kv[1]] = v;
    }
    if (!meta.name) return null;
    return {
        name: String(meta.name),
        description: String(meta.description || ''),
        tools: Array.isArray(meta.tools) ? meta.tools : [],
        instructions: m[2].trim(),
        dir: path.dirname(file),
        meta,
    };
}

/**
 * 从一个目录加载所有技能（支持一层嵌套，便于按领域分组）。
 * @param {string} root
 */
export function loadSkills(root) {
    const out = [];
    if (!fs.existsSync(root)) return out;
    const walk = (dir, depth) => {
        if (depth > 2) return;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(full, depth + 1);
            else if (ent.name === 'SKILL.md') {
                const s = parseSkillFile(full);
                if (s) out.push(s);
            }
        }
    };
    walk(root, 0);
    return out;
}

/**
 * 按关键词选择相关技能（最简触发：名字/描述命中就加载）。
 *
 * 为什么不放全部技能进上下文：技能正文可能几千字，10 个技能就是几万 token。
 * 真实项目里这一步应该用语义检索，这里用关键词是为了零依赖和可解释——
 * 而且能明确回答「为什么这个技能被加载了」。
 *
 * @param {Array} skills
 * @param {string} task
 * @param {number} [max=3]
 */
export function selectSkills(skills, task, max = 3) {
    const q = String(task).toLowerCase();
    const scored = skills
        .map((s) => {
            const hay = `${s.name} ${s.description}`.toLowerCase();
            const tokens = hay.split(/[\s_,，、/]+/).filter((t) => t.length >= 2);
            let score = 0;
            for (const t of tokens) if (q.includes(t)) score += 2;
            // 中文没有空格，用二元组兜底
            for (let i = 0; i < s.description.length - 1; i++) {
                const bi = s.description.slice(i, i + 2);
                if (q.includes(bi)) score += 1;
            }
            return { s, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, max);
    return scored.map((x) => x.s);
}

/** 把选中的技能渲染成一段 system 追加文本 */
export function renderSkills(skills) {
    if (!skills.length) return '';
    return [
        '## 可用技能（按任务匹配加载）',
        ...skills.map((s) => `### ${s.name}\n${s.description}\n\n${s.instructions}`),
    ].join('\n\n');
}

/** 技能声明的工具集合（用于给 Agent 限定可用工具） */
export function skillsToolAllow(skills) {
    const set = new Set();
    for (const s of skills) for (const t of s.tools) set.add(t);
    return set.size ? [...set] : undefined;
}
