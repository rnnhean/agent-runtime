/**
 * 演示用业务数据与工具（订单客服场景）。
 *
 * 数据刻意设计成「有边界」：有一单不存在、有一单超时未发货、有一单金额超补偿阈值。
 * 因为评测要能测出「边界情况处理对不对」，全是 happy path 的数据测不出任何东西。
 */

export const ORDERS = {
    A1001: { id: 'A1001', status: 'shipped', amount: 299, items: 2, createdAt: '2026-11-20', tracking: 'SF1234567890' },
    A1002: { id: 'A1002', status: 'pending', amount: 89, items: 1, createdAt: '2026-11-25', tracking: null },
    A1003: { id: 'A1003', status: 'shipped', amount: 1299, items: 3, createdAt: '2026-11-18', tracking: 'YT9876543210' },
    A1004: { id: 'A1004', status: 'delivered', amount: 45, items: 1, createdAt: '2026-11-10', tracking: 'JD5566778899' },
    A1005: { id: 'A1005', status: 'refunded', amount: 199, items: 1, createdAt: '2026-11-01', tracking: 'SF0001112223' },
};

export const LOGISTICS = {
    A1001: [
        { time: '2026-11-21 09:12', node: '杭州转运中心', desc: '已发出' },
        { time: '2026-11-22 14:30', node: '上海分拨中心', desc: '到达分拨' },
        { time: '2026-11-23 08:05', node: '上海徐汇营业点', desc: '派送中' },
    ],
    A1003: [
        { time: '2026-11-19 10:00', node: '广州转运中心', desc: '已发出' },
        { time: '2026-11-20 06:40', node: '深圳分拨中心', desc: '到达分拨' },
    ],
    A1004: [
        { time: '2026-11-11 15:20', node: '北京朝阳营业点', desc: '已签收' },
    ],
};

export const POLICIES = [
    { id: 'P-REFUND', title: '七天无理由退货', text: '签收后 7 天内可申请无理由退货，商品需保持完好。生鲜、定制类除外。' },
    { id: 'P-COMPENSATE', title: '延迟发货补偿', text: '超过承诺时效 48 小时未发货，可补偿订单金额的 10%，单笔上限 200 元。超过 200 元需主管审批。' },
    { id: 'P-LOST', title: '物流丢失处理', text: '物流超过 7 天无更新视为疑似丢失，可申请补发或全额退款。' },
    { id: 'P-ADDRESS', title: '修改收货地址', text: '仅未发货订单可修改地址；已发货需联系快递拦截，不保证成功。' },
];

const ok = (value) => ({ ok: true, value });
const bad = (error) => ({ ok: false, error });

const orderIdSchema = {
    type: 'object',
    properties: { orderId: { type: 'string', description: '订单号，形如 A1001' } },
    required: ['orderId'],
};

/** 项目自带的工具集（本地工具）。MCP server 也复用它。 */
export function buildExampleTools() {
    return [
        {
            name: 'query_order',
            description: '按订单号查询订单状态、金额、商品数、是否已发货。订单不存在时会返回错误，此时不要臆造。',
            parameters: orderIdSchema,
            timeoutMs: 5000,
            parse: (args) => {
                const id = String(args?.orderId ?? '').trim().toUpperCase();
                if (!id) return bad('orderId 必填');
                if (!/^A\d{4}$/.test(id)) return bad(`订单号格式不对：${id}`);
                return ok({ orderId: id });
            },
            run: async ({ orderId }) => {
                const o = ORDERS[orderId];
                if (!o) throw Object.assign(new Error(`订单 ${orderId} 不存在`), { kind: 'business' });
                return o;
            },
        },
        {
            name: 'query_logistics',
            description: '查询已发货订单的物流轨迹。未发货订单会返回错误。',
            parameters: orderIdSchema,
            timeoutMs: 5000,
            parse: (args) => {
                const id = String(args?.orderId ?? '').trim().toUpperCase();
                if (!id) return bad('orderId 必填');
                return ok({ orderId: id });
            },
            run: async ({ orderId }) => {
                const o = ORDERS[orderId];
                if (!o) throw Object.assign(new Error(`订单 ${orderId} 不存在`), { kind: 'business' });
                if (!o.tracking) throw Object.assign(new Error(`订单 ${orderId} 尚未发货，无物流信息`), { kind: 'business' });
                return LOGISTICS[orderId] || [];
            },
        },
        {
            name: 'search_policy',
            description: '按关键词检索售后政策原文（退货、补偿、丢失、改地址）。回复涉及规则时必须先查这里。',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: '关键词，如 退款、补偿、丢失' } },
                required: ['query'],
            },
            timeoutMs: 5000,
            parse: (args) => {
                const q = String(args?.query ?? '').trim();
                if (!q) return bad('query 必填');
                return ok({ query: q });
            },
            run: async ({ query }) => {
                const hits = POLICIES.filter((p) => `${p.title} ${p.text}`.includes(query) || p.title.includes(query));
                return hits.length ? hits : POLICIES.map((p) => ({ id: p.id, title: p.title }));
            },
        },
    ];
}

/** 一个会强制失败的内部错误工具，用来测 fatal 分支 */
export function buggyTool() {
    return {
        name: 'buggy_internal',
        description: '用于测试：内部错误工具',
        parameters: { type: 'object', properties: {} },
        run: async () => {
            throw new TypeError('undefined is not a function');
        },
    };
}
