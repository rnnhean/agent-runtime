import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSkills, parseSkillFile, selectSkills, renderSkills, skillsToolAllow } from '../src/skills/loader.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sk-'));

function writeSkill(root, dir, { name, description, tools = [], body = '按步骤执行。' }) {
    const d = path.join(root, dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
        path.join(d, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\ntools: [${tools.join(', ')}]\n---\n\n${body}\n`,
    );
    return d;
}

test('解析 SKILL.md：frontmatter + 正文', () => {
    const root = tmp();
    const d = writeSkill(root, 's1', { name: 'order-lookup', description: '查询订单', tools: ['query_order', 'query_logistics'], body: '# 步骤\n先查订单。' });
    const s = parseSkillFile(path.join(d, 'SKILL.md'));
    assert.equal(s.name, 'order-lookup');
    assert.deepEqual(s.tools, ['query_order', 'query_logistics']);
    assert.match(s.instructions, /先查订单/);
});

test('无 frontmatter 的文件被跳过，不报错', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'bad'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bad', 'SKILL.md'), '# 没有头部\n内容');
    assert.equal(loadSkills(root).length, 0);
});

test('递归加载多层目录', () => {
    const root = tmp();
    writeSkill(root, 'a', { name: 'a', description: 'aa' });
    writeSkill(root, path.join('group', 'b'), { name: 'b', description: 'bb' });
    const all = loadSkills(root);
    assert.deepEqual(all.map((s) => s.name).sort(), ['a', 'b']);
});

test('按任务选择技能：相关才加载', () => {
    const root = tmp();
    writeSkill(root, 'order', { name: 'order-lookup', description: '查询订单状态和物流轨迹' });
    writeSkill(root, 'report', { name: 'daily-report', description: '生成每日运营报表' });
    const all = loadSkills(root);

    const picked = selectSkills(all, '我的订单到哪了');
    assert.deepEqual(picked.map((s) => s.name), ['order-lookup']);

    const none = selectSkills(all, '今天天气怎么样');
    assert.equal(none.length, 0, '不相关的任务不应加载任何技能');
});

test('渲染技能文本与工具白名单', () => {
    const root = tmp();
    writeSkill(root, 'o', { name: 'order', description: '订单', tools: ['query_order', 'search_policy'] });
    const [s] = loadSkills(root);
    const text = renderSkills([s]);
    assert.match(text, /可用技能/);
    assert.match(text, /order/);
    assert.deepEqual(skillsToolAllow([s]).sort(), ['query_order', 'search_policy']);
    assert.equal(skillsToolAllow([]), undefined);
});
