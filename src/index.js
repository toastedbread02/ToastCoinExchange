const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

const FAUCET_TOAST = 1000;
const FAUCET_CHF = 100;
const FAUCET_COOLDOWN = 60 * 60;

const START_PRICE = 0.01;

/*
 * Reserved system account that provides liquidity.
 * Its address is rejected by the user-facing endpoints.
 */
const MARKET_MAKER = "mm:toast-liquidity-provider";

/*
 * Reported alongside circulating supply. Minting is not capped against
 * it yet, so treat it as the advertised ceiling rather than a limit.
 */
const MAX_SUPPLY = 1000000;

const MM_START_TOAST = 500000;
const MM_START_CHF = 500000;
const MM_LEVELS = 6;
const MM_STEP = 0.01;
const MM_SIZE = 2500;

function response(data, status = 200) {
    return new Response(
        JSON.stringify(data),
        {
            status,
            headers: {
                "Content-Type": "application/json",
                ...CORS_HEADERS
            }
        }
    );
}

function now() {
    return Math.floor(Date.now() / 1000);
}

async function ensureSeedHistory(env) {
    const existing = await env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM price_history
    `).first();

    if (Number(existing?.count || 0) === 0) {
        await seedHistory(env);
    }
}


async function ensureMarket(env) {
    await ensureSeedHistory(env);

    await ensureMarketMaker(env);
}

async function seedHistory(env) {
    const current = now();

    const demoPrices = [
        0.0087,
        0.0091,
        0.0089,
        0.0094,
        0.0092,
        0.0097,
        0.0095,
        0.0101,
        0.0098,
        0.0104,
        0.0102,
        0.0107,
        0.0105,
        0.0109,
        0.0106,
        0.0112,
        0.0108,
        0.0110,
        0.0107,
        0.0109,
        0.0104,
        0.0106,
        0.0103,
        0.0101,
        0.0103,
        0.0100,
        0.0102,
        0.0099,
        0.0101,
        0.0100
    ];

    const statements = demoPrices.map((price, index) => {
        return env.DB.prepare(`
            INSERT INTO price_history
            (
                price,
                volume,
                timestamp
            )
            VALUES (?, ?, ?)
        `).bind(
            price,
            Math.floor(Math.random() * 500) + 50,
            current - ((demoPrices.length - index) * 3600)
        );
    });

    await env.DB.batch(statements);
}

async function lastPrice(env) {
    const latest = await env.DB.prepare(`
        SELECT price
        FROM price_history
        ORDER BY id DESC
        LIMIT 1
    `).first();

    return Number(latest?.price) || START_PRICE;
}


/*
 * The liquidity provider is a normal account holding TOAST and CHF.
 * Every order it publishes is funded from its balance, and cancelled
 * orders return the locked funds, so the book is always solvent.
 */
async function ensureMarketMaker(env) {
    await env.DB.prepare(`
        INSERT INTO balances
        (
            address,
            toast,
            chf,
            toast_locked,
            chf_locked
        )
        VALUES (?, ?, ?, 0, 0)

        ON CONFLICT(address) DO NOTHING
    `).bind(
        MARKET_MAKER,
        MM_START_TOAST,
        MM_START_CHF
    ).run();

    const open = await env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM orders
        WHERE address = ?
          AND status = 'open'
          AND remaining > 0
    `).bind(MARKET_MAKER).first();

    if (Number(open?.count || 0) === 0) {
        await quoteMarket(env);
    }
}


async function quoteMarket(env) {
    const mid = await lastPrice(env);

    const open = await env.DB.prepare(`
        SELECT
            id,
            side,
            remaining,
            price
        FROM orders
        WHERE address = ?
          AND status = 'open'
          AND remaining > 0
    `).bind(MARKET_MAKER).all();

    const statements = [];

    let refundToast = 0;
    let refundChf = 0;

    for (const order of open.results) {
        if (order.side === "sell") {
            refundToast += Number(order.remaining);
        } else {
            refundChf +=
                Number(order.remaining) *
                Number(order.price);
        }

        statements.push(
            env.DB.prepare(`
                UPDATE orders
                SET
                    status = 'cancelled',
                    remaining = 0
                WHERE id = ?
            `).bind(order.id)
        );
    }

    if (open.results.length > 0) {
        statements.push(
            env.DB.prepare(`
                UPDATE balances
                SET
                    toast = toast + ?,
                    toast_locked = toast_locked - ?,
                    chf = chf + ?,
                    chf_locked = chf_locked - ?
                WHERE address = ?
            `).bind(
                refundToast,
                refundToast,
                refundChf,
                refundChf,
                MARKET_MAKER
            )
        );
    }

    const current = now();

    let lockToast = 0;
    let lockChf = 0;

    for (let level = 1; level <= MM_LEVELS; level++) {
        const askPrice =
            mid * (1 + MM_STEP * level);

        const bidPrice =
            mid * (1 - MM_STEP * level);

        statements.push(
            env.DB.prepare(`
                INSERT INTO orders
                (
                    address,
                    side,
                    amount,
                    remaining,
                    price,
                    created_at,
                    status
                )
                VALUES (?, 'sell', ?, ?, ?, ?, 'open')
            `).bind(
                MARKET_MAKER,
                MM_SIZE,
                MM_SIZE,
                askPrice,
                current
            )
        );

        statements.push(
            env.DB.prepare(`
                INSERT INTO orders
                (
                    address,
                    side,
                    amount,
                    remaining,
                    price,
                    created_at,
                    status
                )
                VALUES (?, 'buy', ?, ?, ?, ?, 'open')
            `).bind(
                MARKET_MAKER,
                MM_SIZE,
                MM_SIZE,
                bidPrice,
                current
            )
        );

        lockToast += MM_SIZE;
        lockChf += MM_SIZE * bidPrice;
    }

    statements.push(
        env.DB.prepare(`
            UPDATE balances
            SET
                toast = toast - ?,
                toast_locked = toast_locked + ?,
                chf = chf - ?,
                chf_locked = chf_locked + ?
            WHERE address = ?
        `).bind(
            lockToast,
            lockToast,
            lockChf,
            lockChf,
            MARKET_MAKER
        )
    );

    await env.DB.batch(statements);
}


async function getBalance(env, address) {
    let balance = await env.DB.prepare(`
        SELECT
            address,
            toast,
            chf,
            toast_locked,
            chf_locked
        FROM balances
        WHERE address = ?
    `).bind(address).first();

    if (!balance) {
        await env.DB.prepare(`
            INSERT INTO balances
            (
                address,
                toast,
                chf,
                toast_locked,
                chf_locked
            )
            VALUES (?, 0, 0, 0, 0)
        `).bind(address).run();

        balance = {
            address,
            toast: 0,
            chf: 0,
            toast_locked: 0,
            chf_locked: 0
        };
    }

    return balance;
}

/*
 * Open orders for one address, newest first, so a wallet can list and
 * cancel its own resting orders. The market maker's quotes sit on its own
 * reserved address, so they never show up here.
 */
async function openOrders(env, address) {
    const rows = await env.DB.prepare(`
        SELECT
            id,
            side,
            price,
            amount,
            remaining,
            created_at
        FROM orders
        WHERE address = ?
          AND status = 'open'
          AND remaining > 0
        ORDER BY id DESC
        LIMIT 50
    `).bind(address).all();

    return (rows.results || []).map(row => ({
        id: row.id,
        side: row.side,
        price: row.price,
        amount: row.amount,
        remaining: row.remaining,
        createdAt: row.created_at
    }));
}


/*
 * Minted TOAST actually held by wallets. Faucet claims and mining rewards
 * add to this, so supply rises as the testnet mints. The liquidity
 * provider is protocol-owned, not circulating, so it is excluded.
 */
async function circulatingSupply(env) {
    const row = await env.DB.prepare(`
        SELECT COALESCE(SUM(toast + toast_locked), 0) AS supply
        FROM balances
        WHERE address NOT LIKE 'mm:%'
    `).first();

    /*
     * REAL arithmetic leaves noise like 8107.500000000002; trim it so
     * clients do not have to.
     */
    return Number(Number(row?.supply || 0).toFixed(6));
}


/*
 * Percentage move against the newest price at least 24 hours old. When the
 * market has not traded in a day the last known price before that window is
 * used, which is what a ticker shows for a quiet market.
 */
async function change24h(env, price) {
    const prior = await env.DB.prepare(`
        SELECT price
        FROM price_history
        WHERE timestamp <= ?
        ORDER BY timestamp DESC
        LIMIT 1
    `).bind(now() - 86400).first();

    const base = Number(prior?.price || 0);

    if (!base || !price) {
        return null;
    }

    return Number((((price - base) / base) * 100).toFixed(4));
}


async function market(env) {
    await ensureMarket(env);

    const volume = await env.DB.prepare(`
        SELECT COALESCE(SUM(volume), 0) AS volume
        FROM price_history
        WHERE timestamp >= ?
    `).bind(now() - 86400).first();

    const supply = await circulatingSupply(env);
    const price = await lastPrice(env);
    const change = await change24h(env, price);

    return {
        symbol: "TOAST",
        currency: "CHF",
        price,
        change24h: change,
        volume24h: Number(Number(volume?.volume ?? 0).toFixed(6)),
        supply,
        maxSupply: MAX_SUPPLY,
        marketCap: Number((price * supply).toFixed(6))
    };
}

async function orderBook(env) {
    const bids = await env.DB.prepare(`
        SELECT
            price,
            SUM(remaining) AS amount
        FROM orders
        WHERE side = 'buy'
          AND status = 'open'
          AND remaining > 0
        GROUP BY price
        ORDER BY price DESC
        LIMIT 20
    `).all();

    const asks = await env.DB.prepare(`
        SELECT
            price,
            SUM(remaining) AS amount
        FROM orders
        WHERE side = 'sell'
          AND status = 'open'
          AND remaining > 0
        GROUP BY price
        ORDER BY price ASC
        LIMIT 20
    `).all();

    return {
        bids: bids.results,
        asks: asks.results
    };
}

async function history(env, range) {
    await ensureSeedHistory(env);

    const ranges = {
        "1M": 60 * 60,
        "1D": 60 * 60 * 24,
        "1MON": 60 * 60 * 24 * 30,
        "1Y": 60 * 60 * 24 * 365,
        "MAX": 60 * 60 * 24 * 3650
    };

    const seconds = ranges[range] ?? ranges["1D"];

    const result = await env.DB.prepare(`
        SELECT
            price,
            volume,
            timestamp
        FROM price_history
        WHERE timestamp >= ?
        ORDER BY timestamp ASC
    `).bind(now() - seconds).all();

    return result.results;
}

async function recentTrades(env) {
    const result = await env.DB.prepare(`
        SELECT
            amount,
            price,
            timestamp
        FROM trades
        ORDER BY timestamp DESC
        LIMIT 50
    `).all();

    return result.results;
}

async function placeOrder(env, body) {
    const address = String(body.address || "").trim();
    const side = body.side;
    const amount = Number(body.amount);
    const price = Number(body.price);

    if (!address) {
        throw new Error("Wallet address required");
    }

    if (address.startsWith("mm:")) {
        throw new Error("Reserved address");
    }

    if (side !== "buy" && side !== "sell") {
        throw new Error("Side must be buy or sell");
    }

    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Invalid amount");
    }

    if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Invalid price");
    }

    const balance = await getBalance(env, address);

    if (side === "sell") {
        if (balance.toast < amount) {
            throw new Error(
                `Insufficient TOAST. Available: ${balance.toast}`
            );
        }

        await env.DB.prepare(`
            UPDATE balances
            SET
                toast = toast - ?,
                toast_locked = toast_locked + ?
            WHERE address = ?
              AND toast >= ?
        `).bind(
            amount,
            amount,
            address,
            amount
        ).run();

    } else {
        const required = amount * price;

        if (balance.chf < required) {
            throw new Error(
                `Insufficient CHF. Available: ${balance.chf}`
            );
        }

        await env.DB.prepare(`
            UPDATE balances
            SET
                chf = chf - ?,
                chf_locked = chf_locked + ?
            WHERE address = ?
              AND chf >= ?
        `).bind(
            required,
            required,
            address,
            required
        ).run();
    }

    const result = await env.DB.prepare(`
        INSERT INTO orders
        (
            address,
            side,
            amount,
            remaining,
            price,
            created_at,
            status
        )
        VALUES (?, ?, ?, ?, ?, ?, 'open')
    `).bind(
        address,
        side,
        amount,
        amount,
        price,
        now()
    ).run();

    const orderId = result.meta.last_row_id;

    await matchOrders(env, orderId);

    return {
        success: true,
        orderId
    };
}

async function matchOrders(env, orderId) {
    let order = await env.DB.prepare(`
        SELECT *
        FROM orders
        WHERE id = ?
    `).bind(orderId).first();

    if (!order) {
        return;
    }

    let matched = false;

    while (order.remaining > 0) {
        let match;

        if (order.side === "buy") {
            match = await env.DB.prepare(`
                SELECT *
                FROM orders
                WHERE side = 'sell'
                  AND status = 'open'
                  AND remaining > 0
                  AND price <= ?
                  AND address != ?
                ORDER BY price ASC, created_at ASC
                LIMIT 1
            `).bind(
                order.price,
                order.address
            ).first();

        } else {
            match = await env.DB.prepare(`
                SELECT *
                FROM orders
                WHERE side = 'buy'
                  AND status = 'open'
                  AND remaining > 0
                  AND price >= ?
                  AND address != ?
                ORDER BY price DESC, created_at ASC
                LIMIT 1
            `).bind(
                order.price,
                order.address
            ).first();
        }

        if (!match) {
            break;
        }

        const amount = Math.min(
            order.remaining,
            match.remaining
        );

        const tradePrice = match.price;

        const buyer =
            order.side === "buy"
                ? order
                : match;

        const seller =
            order.side === "sell"
                ? order
                : match;

        const cost = amount * tradePrice;

        let buyerReserved = 0;

        if (buyer.side === "buy") {
            buyerReserved = amount * buyer.price;
        }

        const buyerRefund =
            buyerReserved - cost;

        await env.DB.batch([
            // The buyer reserved amount * limit price. Release the whole
            // reservation and return the difference between that and the
            // executed cost to the available balance; leaving the refund
            // in chf_locked stranded the money once the order was filled.
            env.DB.prepare(`
                UPDATE balances
                SET
                    toast = toast + ?,
                    chf = chf + ?,
                    chf_locked = chf_locked - ?
                WHERE address = ?
            `).bind(
                amount,
                buyerRefund,
                buyerReserved,
                buyer.address
            ),

            env.DB.prepare(`
                UPDATE balances
                SET
                    chf = chf + ?,
                    toast_locked = toast_locked - ?
                WHERE address = ?
            `).bind(
                cost,
                amount,
                seller.address
            ),

            env.DB.prepare(`
                UPDATE orders
                SET
                    remaining = remaining - ?,
                    status =
                        CASE
                            WHEN remaining - ? <= 0
                            THEN 'filled'
                            ELSE 'open'
                        END
                WHERE id = ?
            `).bind(
                amount,
                amount,
                order.id
            ),

            env.DB.prepare(`
                UPDATE orders
                SET
                    remaining = remaining - ?,
                    status =
                        CASE
                            WHEN remaining - ? <= 0
                            THEN 'filled'
                            ELSE 'open'
                        END
                WHERE id = ?
            `).bind(
                amount,
                amount,
                match.id
            ),

            env.DB.prepare(`
                INSERT INTO trades
                (
                    buy_order_id,
                    sell_order_id,
                    amount,
                    price,
                    timestamp
                )
                VALUES (?, ?, ?, ?, ?)
            `).bind(
                buyer.id,
                seller.id,
                amount,
                tradePrice,
                now()
            ),

            env.DB.prepare(`
                INSERT INTO price_history
                (
                    price,
                    volume,
                    timestamp
                )
                VALUES (?, ?, ?)
            `).bind(
                tradePrice,
                amount,
                now()
            )
        ]);

        order.remaining -= amount;

        matched = true;

        order = await env.DB.prepare(`
            SELECT *
            FROM orders
            WHERE id = ?
        `).bind(orderId).first();

        if (!order) {
            break;
        }
    }

    /*
     * A fill is the only thing that moves the market. Re-quote around
     * the new last price so the next trade happens at a new level.
     */
    if (matched) {
        await quoteMarket(env);
    }
}

async function cancelOrder(env, address, orderId) {
    const order = await env.DB.prepare(`
        SELECT *
        FROM orders
        WHERE id = ?
          AND address = ?
          AND status = 'open'
    `).bind(
        orderId,
        address
    ).first();

    if (!order) {
        throw new Error("Open order not found");
    }

    const remaining = order.remaining;

    if (order.side === "sell") {
        await env.DB.batch([
            env.DB.prepare(`
                UPDATE balances
                SET
                    toast = toast + ?,
                    toast_locked = toast_locked - ?
                WHERE address = ?
            `).bind(
                remaining,
                remaining,
                address
            ),

            env.DB.prepare(`
                UPDATE orders
                SET
                    status = 'cancelled',
                    remaining = 0
                WHERE id = ?
            `).bind(orderId)
        ]);

    } else {
        const refund =
            remaining * order.price;

        await env.DB.batch([
            env.DB.prepare(`
                UPDATE balances
                SET
                    chf = chf + ?,
                    chf_locked = chf_locked - ?
                WHERE address = ?
            `).bind(
                refund,
                refund,
                address
            ),

            env.DB.prepare(`
                UPDATE orders
                SET
                    status = 'cancelled',
                    remaining = 0
                WHERE id = ?
            `).bind(orderId)
        ]);
    }

    return {
        success: true
    };
}

async function faucet(env, address) {
    if (!address) {
        throw new Error(
            "Wallet address required"
        );
    }

    if (address.startsWith("mm:")) {
        throw new Error("Reserved address");
    }

    const current = now();

    const existing = await env.DB.prepare(`
        SELECT *
        FROM faucet_claims
        WHERE address = ?
    `).bind(address).first();

    if (existing) {
        const elapsed =
            current - existing.last_claim;

        if (elapsed < FAUCET_COOLDOWN) {
            return {
                success: false,
                cooldown:
                    FAUCET_COOLDOWN - elapsed
            };
        }
    }

    await getBalance(
        env,
        address
    );

    await env.DB.batch([
        env.DB.prepare(`
            UPDATE balances
            SET
                toast = toast + ?,
                chf = chf + ?
            WHERE address = ?
        `).bind(
            FAUCET_TOAST,
            FAUCET_CHF,
            address
        ),

        env.DB.prepare(`
            INSERT INTO faucet_claims
            (
                address,
                last_claim
            )
            VALUES (?, ?)

            ON CONFLICT(address)
            DO UPDATE SET
                last_claim =
                    excluded.last_claim
        `).bind(
            address,
            current
        )
    ]);

    return {
        success: true,
        toast: FAUCET_TOAST,
        chf: FAUCET_CHF
    };
}

export default {
    async fetch(request, env) {
        try {
            if (request.method === "OPTIONS") {
                return new Response(
                    null,
                    {
                        headers: CORS_HEADERS
                    }
                );
            }

            const url =
                new URL(request.url);

            if (url.pathname === "/") {
                return response({
                    name: "ToastCoin Exchange",
                    symbol: "TOAST",
                    network: "TESTNET",
                    status: "online",
                    message: "Proof of Toast"
                });
            }

            if (
                url.pathname === "/api/market" &&
                request.method === "GET"
            ) {
                return response(
                    await market(env)
                );
            }

            if (
                url.pathname === "/api/history" &&
                request.method === "GET"
            ) {
                const range =
                    url.searchParams.get("range")
                    || "1D";

                return response({
                    range,
                    data: await history(
                        env,
                        range
                    )
                });
            }

            if (
                url.pathname === "/api/orderbook" &&
                request.method === "GET"
            ) {
                return response(
                    await orderBook(env)
                );
            }

            if (
                url.pathname === "/api/trades" &&
                request.method === "GET"
            ) {
                return response({
                    trades:
                        await recentTrades(env)
                });
            }

            if (
                url.pathname === "/api/balance" &&
                request.method === "GET"
            ) {
                const address =
                    url.searchParams.get(
                        "address"
                    );

                if (!address) {
                    return response(
                        {
                            error:
                                "Address required"
                        },
                        400
                    );
                }

                return response(
                    await getBalance(
                        env,
                        address
                    )
                );
            }

            if (
                url.pathname === "/api/orders" &&
                request.method === "GET"
            ) {
                const address =
                    url.searchParams.get(
                        "address"
                    );

                if (!address) {
                    return response(
                        {
                            error:
                                "Address required"
                        },
                        400
                    );
                }

                return response({
                    orders:
                        await openOrders(
                            env,
                            address
                        )
                });
            }

            if (
                url.pathname === "/api/faucet" &&
                request.method === "POST"
            ) {
                const body =
                    await request.json();

                return response(
                    await faucet(
                        env,
                        body.address
                    )
                );
            }

            if (
                url.pathname === "/api/order" &&
                request.method === "POST"
            ) {
                const body =
                    await request.json();

                return response(
                    await placeOrder(
                        env,
                        body
                    )
                );
            }

            if (
                url.pathname === "/api/order" &&
                request.method === "DELETE"
            ) {
                const body =
                    await request.json();

                return response(
                    await cancelOrder(
                        env,
                        body.address,
                        Number(body.orderId)
                    )
                );
            }

            if (
                url.pathname === "/api/miner/start" &&
                request.method === "POST"
            ) {
                const body = await request.json();

                const address =
                    String(body.address || "").trim();

                if (!address) {
                    return response({
                        error: "Wallet address required"
                    }, 400);
                }

                await getBalance(env, address);

                const existing =
                    await env.DB.prepare(`
                        SELECT *
                        FROM mining_sessions
                        WHERE address = ?
                          AND active = 1
                        LIMIT 1
                    `)
                    .bind(address)
                    .first();

                if (existing) {
                    return response({
                        success: true,
                        sessionId: existing.id,
                        startedAt: existing.started_at
                    });
                }

                const sessionId =
                    crypto.randomUUID();

                const current =
                    now();

                await env.DB.prepare(`
                    INSERT INTO mining_sessions
                    (
                        id,
                        address,
                        started_at,
                        last_claim,
                        total_reward,
                        active
                    )
                    VALUES (?, ?, ?, ?, 0, 1)
                `)
                .bind(
                    sessionId,
                    address,
                    current,
                    current
                )
                .run();

                return response({
                    success: true,
                    sessionId,
                    startedAt: current
                });
            }


            if (
                url.pathname === "/api/miner/claim" &&
                request.method === "POST"
            ) {
                const body =
                    await request.json();

                const address =
                    String(body.address || "").trim();

                const sessionId =
                    String(body.sessionId || "").trim();

                if (!address || !sessionId) {
                    return response({
                        error:
                            "Wallet address and session ID required"
                    }, 400);
                }

                const session =
                    await env.DB.prepare(`
                        SELECT *
                        FROM mining_sessions
                        WHERE id = ?
                          AND address = ?
                          AND active = 1
                    `)
                    .bind(
                        sessionId,
                        address
                    )
                    .first();

                if (!session) {
                    return response({
                        error:
                            "Mining session not found"
                    }, 404);
                }

                const current =
                    now();

                const elapsed =
                    Math.min(
                        current - session.started_at,
                        600
                    );

                const totalReward =
                    (elapsed / 600) * 100;

                const reward =
                    Math.max(
                        0,
                        totalReward -
                        session.total_reward
                    );

                if (reward > 0) {
                    await env.DB.batch([
                        env.DB.prepare(`
                            UPDATE balances
                            SET toast = toast + ?
                            WHERE address = ?
                        `)
                        .bind(
                            reward,
                            address
                        ),

                        env.DB.prepare(`
                            UPDATE mining_sessions
                            SET
                                last_claim = ?,
                                total_reward = ?
                            WHERE id = ?
                        `)
                        .bind(
                            current,
                            totalReward,
                            sessionId
                        )
                    ]);
                }

                return response({
                    success: true,
                    reward,
                    total: totalReward
                });
            }


            if (
                url.pathname === "/api/miner/stop" &&
                request.method === "POST"
            ) {
                const body =
                    await request.json();

                const address =
                    String(body.address || "").trim();

                const sessionId =
                    String(body.sessionId || "").trim();

                if (!address || !sessionId) {
                    return response({
                        error:
                            "Wallet address and session ID required"
                    }, 400);
                }

                const session =
                    await env.DB.prepare(`
                        SELECT *
                        FROM mining_sessions
                        WHERE id = ?
                          AND address = ?
                          AND active = 1
                    `)
                    .bind(
                        sessionId,
                        address
                    )
                    .first();

                if (!session) {
                    return response({
                        error:
                            "Mining session not found"
                    }, 404);
                }

                const current =
                    now();

                const elapsed =
                    Math.min(
                        current - session.started_at,
                        600
                    );

                const totalReward =
                    (elapsed / 600) * 100;

                const reward =
                    Math.max(
                        0,
                        totalReward -
                        session.total_reward
                    );

                await env.DB.batch([
                    env.DB.prepare(`
                        UPDATE balances
                        SET toast = toast + ?
                        WHERE address = ?
                    `)
                    .bind(
                        reward,
                        address
                    ),

                    env.DB.prepare(`
                        UPDATE mining_sessions
                        SET
                            last_claim = ?,
                            total_reward = ?,
                            active = 0
                        WHERE id = ?
                    `)
                    .bind(
                        current,
                        totalReward,
                        sessionId
                    )
                ]);

                return response({
                    success: true,
                    reward,
                    total: totalReward
                });
            }

            return response(
                {
                    error: "Not found"
                },
                404
            );

        } catch (error) {
            return response(
                {
                    error:
                        error.message
                },
                500
            );
        }
    }
};
