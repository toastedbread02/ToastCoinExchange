const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

const FAUCET_TOAST = 1000;
const FAUCET_CHF = 100;
const FAUCET_COOLDOWN = 60 * 60;


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


async function getBalance(env, address) {

    let balance = await env.DB
        .prepare(`
            SELECT
                address,
                toast,
                chf,
                toast_locked,
                chf_locked
            FROM balances
            WHERE address = ?
        `)
        .bind(address)
        .first();

    if (!balance) {

        await env.DB
            .prepare(`
                INSERT INTO balances
                (
                    address,
                    toast,
                    chf,
                    toast_locked,
                    chf_locked
                )
                VALUES (?, 0, 0, 0, 0)
            `)
            .bind(address)
            .run();

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


async function market(env) {

    const latest = await env.DB
        .prepare(`
            SELECT price
            FROM price_history
            ORDER BY timestamp DESC
            LIMIT 1
        `)
        .first();

    const volume = await env.DB
        .prepare(`
            SELECT COALESCE(SUM(amount), 0) AS volume
            FROM trades
            WHERE timestamp >= ?
        `)
        .bind(now() - 86400)
        .first();

    const supply = 1000000;
    const price = latest?.price ?? 0;

    return {
        symbol: "TOAST",
        currency: "CHF",
        price,
        volume24h: volume?.volume ?? 0,
        supply,
        marketCap: price * supply
    };
}


async function orderBook(env) {

    const bids = await env.DB
        .prepare(`
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
        `)
        .all();

    const asks = await env.DB
        .prepare(`
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
        `)
        .all();

    return {
        bids: bids.results,
        asks: asks.results
    };
}


async function history(env, range) {

    const ranges = {
        "1M": 60 * 60,
        "1D": 60 * 60 * 24,
        "1MON": 60 * 60 * 24 * 30,
        "1Y": 60 * 60 * 24 * 365,
        "MAX": 60 * 60 * 24 * 3650
    };

    const seconds = ranges[range] ?? ranges["1D"];

    const result = await env.DB
        .prepare(`
            SELECT
                price,
                volume,
                timestamp
            FROM price_history
            WHERE timestamp >= ?
            ORDER BY timestamp ASC
        `)
        .bind(now() - seconds)
        .all();

    return result.results;
}


async function recentTrades(env) {

    const result = await env.DB
        .prepare(`
            SELECT
                amount,
                price,
                timestamp
            FROM trades
            ORDER BY timestamp DESC
            LIMIT 50
        `)
        .all();

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

        await env.DB
            .prepare(`
                UPDATE balances
                SET
                    toast = toast - ?,
                    toast_locked = toast_locked + ?
                WHERE address = ?
                  AND toast >= ?
            `)
            .bind(
                amount,
                amount,
                address,
                amount
            )
            .run();

    } else {

        const required = amount * price;

        if (balance.chf < required) {
            throw new Error(
                `Insufficient CHF. Available: ${balance.chf}`
            );
        }

        await env.DB
            .prepare(`
                UPDATE balances
                SET
                    chf = chf - ?,
                    chf_locked = chf_locked + ?
                WHERE address = ?
                  AND chf >= ?
            `)
            .bind(
                required,
                required,
                address,
                required
            )
            .run();
    }


    const result = await env.DB
        .prepare(`
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
        `)
        .bind(
            address,
            side,
            amount,
            amount,
            price,
            now()
        )
        .run();


    const orderId = result.meta.last_row_id;

    await matchOrders(env, orderId);

    return {
        success: true,
        orderId
    };
}


async function matchOrders(env, orderId) {

    let order = await env.DB
        .prepare(`
            SELECT *
            FROM orders
            WHERE id = ?
        `)
        .bind(orderId)
        .first();

    if (!order) {
        return;
    }


    while (order.remaining > 0) {

        let match;


        if (order.side === "buy") {

            match = await env.DB
                .prepare(`
                    SELECT *
                    FROM orders
                    WHERE side = 'sell'
                      AND status = 'open'
                      AND remaining > 0
                      AND price <= ?
                      AND address != ?
                    ORDER BY price ASC, created_at ASC
                    LIMIT 1
                `)
                .bind(
                    order.price,
                    order.address
                )
                .first();

        } else {

            match = await env.DB
                .prepare(`
                    SELECT *
                    FROM orders
                    WHERE side = 'buy'
                      AND status = 'open'
                      AND remaining > 0
                      AND price >= ?
                      AND address != ?
                    ORDER BY price DESC, created_at ASC
                    LIMIT 1
                `)
                .bind(
                    order.price,
                    order.address
                )
                .first();
        }


        if (!match) {
            break;
        }


        const amount = Math.min(
            order.remaining,
            match.remaining
        );


        // The older resting order determines
        // the execution price.
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


        /*
         * Buyer reserved money at their LIMIT price.
         *
         * If they bought cheaper than their limit,
         * the difference gets unlocked.
         */

        let buyerReserved = 0;

        if (buyer.side === "buy") {
            buyerReserved = amount * buyer.price;
        }


        const buyerRefund =
            buyerReserved - cost;


        await env.DB.batch([

            // Buyer receives TOAST.
            env.DB
                .prepare(`
                    UPDATE balances
                    SET
                        toast = toast + ?,
                        chf_locked = chf_locked - ? + ?
                    WHERE address = ?
                `)
                .bind(
                    amount,
                    buyerReserved,
                    buyerRefund,
                    buyer.address
                ),


            // Seller receives CHF.
            env.DB
                .prepare(`
                    UPDATE balances
                    SET
                        chf = chf + ?,
                        toast_locked = toast_locked - ?
                    WHERE address = ?
                `)
                .bind(
                    cost,
                    amount,
                    seller.address
                ),


            // Current order.
            env.DB
                .prepare(`
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
                `)
                .bind(
                    amount,
                    amount,
                    order.id
                ),


            // Matching order.
            env.DB
                .prepare(`
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
                `)
                .bind(
                    amount,
                    amount,
                    match.id
                ),


            // Trade history.
            env.DB
                .prepare(`
                    INSERT INTO trades
                    (
                        buy_order_id,
                        sell_order_id,
                        amount,
                        price,
                        timestamp
                    )
                    VALUES (?, ?, ?, ?, ?)
                `)
                .bind(
                    buyer.id,
                    seller.id,
                    amount,
                    tradePrice,
                    now()
                ),


            // Chart history.
            env.DB
                .prepare(`
                    INSERT INTO price_history
                    (
                        price,
                        volume,
                        timestamp
                    )
                    VALUES (?, ?, ?)
                `)
                .bind(
                    tradePrice,
                    amount,
                    now()
                )
        ]);


        order.remaining -= amount;


        order = await env.DB
            .prepare(`
                SELECT *
                FROM orders
                WHERE id = ?
            `)
            .bind(orderId)
            .first();


        if (!order) {
            break;
        }
    }
}


async function cancelOrder(env, address, orderId) {

    const order = await env.DB
        .prepare(`
            SELECT *
            FROM orders
            WHERE id = ?
              AND address = ?
              AND status = 'open'
        `)
        .bind(
            orderId,
            address
        )
        .first();


    if (!order) {
        throw new Error(
            "Open order not found"
        );
    }


    if (order.remaining <= 0) {
        throw new Error(
            "Order is already filled"
        );
    }


    const remaining = order.remaining;


    if (order.side === "sell") {

        await env.DB.batch([

            env.DB
                .prepare(`
                    UPDATE balances
                    SET
                        toast = toast + ?,
                        toast_locked = toast_locked - ?
                    WHERE address = ?
                `)
                .bind(
                    remaining,
                    remaining,
                    address
                ),

            env.DB
                .prepare(`
                    UPDATE orders
                    SET
                        status = 'cancelled',
                        remaining = 0
                    WHERE id = ?
                `)
                .bind(orderId)

        ]);

    } else {

        const refund =
            remaining * order.price;

        await env.DB.batch([

            env.DB
                .prepare(`
                    UPDATE balances
                    SET
                        chf = chf + ?,
                        chf_locked = chf_locked - ?
                    WHERE address = ?
                `)
                .bind(
                    refund,
                    refund,
                    address
                ),

            env.DB
                .prepare(`
                    UPDATE orders
                    SET
                        status = 'cancelled',
                        remaining = 0
                    WHERE id = ?
                `)
                .bind(orderId)

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


    const current = now();


    const existing = await env.DB
        .prepare(`
            SELECT *
            FROM faucet_claims
            WHERE address = ?
        `)
        .bind(address)
        .first();


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

        env.DB
            .prepare(`
                UPDATE balances
                SET
                    toast = toast + ?,
                    chf = chf + ?
                WHERE address = ?
            `)
            .bind(
                FAUCET_TOAST,
                FAUCET_CHF,
                address
            ),


        env.DB
            .prepare(`
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
            `)
            .bind(
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

                return new Response(null, {
                    headers: CORS_HEADERS
                });
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

                return response({
                    range:
                        url.searchParams.get(
                            "range"
                        ) || "1D",

                    data:
                        await history(
                            env,
                            url.searchParams.get(
                                "range"
                            ) || "1D"
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
                    return response({
                        error:
                            "Address required"
                    }, 400);
                }


                return response(
                    await getBalance(
                        env,
                        address
                    )
                );
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


            return response({
                error: "Not found"
            }, 404);


        } catch (error) {

            return response({
                error: error.message
            }, 500);
        }
    }
};