const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};


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


function timestamp() {
    return Math.floor(Date.now() / 1000);
}


async function getBalance(env, address) {

    let balance = await env.DB
        .prepare(`
            SELECT address, toast, chf
            FROM balances
            WHERE address = ?
        `)
        .bind(address)
        .first();


    if (!balance) {

        await env.DB
            .prepare(`
                INSERT INTO balances
                (address, toast, chf)
                VALUES (?, 0, 0)
            `)
            .bind(address)
            .run();


        balance = {
            address,
            toast: 0,
            chf: 0
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
        .bind(timestamp() - 86400)
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


    const seconds =
        ranges[range] ?? ranges["1D"];


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
        .bind(timestamp() - seconds)
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

    const {
        address,
        side,
        amount,
        price
    } = body;


    if (!address) {
        throw new Error("Wallet address required");
    }


    if (
        side !== "buy" &&
        side !== "sell"
    ) {
        throw new Error("Side must be buy or sell");
    }


    const quantity = Number(amount);
    const limitPrice = Number(price);


    if (
        !Number.isFinite(quantity) ||
        quantity <= 0
    ) {
        throw new Error("Invalid amount");
    }


    if (
        !Number.isFinite(limitPrice) ||
        limitPrice <= 0
    ) {
        throw new Error("Invalid price");
    }


    const balance =
        await getBalance(env, address);


    if (side === "buy") {

        const requiredCHF =
            quantity * limitPrice;


        if (balance.chf < requiredCHF) {

            throw new Error(
                `Insufficient CHF. You need ${requiredCHF.toFixed(4)} CHF.`
            );

        }

    }


    if (side === "sell") {

        if (balance.toast < quantity) {

            throw new Error(
                `Insufficient TOAST. You have ${balance.toast}.`
            );

        }

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
            quantity,
            quantity,
            limitPrice,
            timestamp()
        )
        .run();


    const orderId =
        result.meta.last_row_id;


    await matchOrders(
        env,
        orderId
    );


    return {
        success: true,
        orderId
    };
}


async function matchOrders(env, orderId) {

    const order = await env.DB
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


        const amount =
            Math.min(
                order.remaining,
                match.remaining
            );


        const tradePrice =
            match.price;


        const buyer =
            order.side === "buy"
                ? order
                : match;


        const seller =
            order.side === "sell"
                ? order
                : match;


        const cost =
            amount * tradePrice;


        const buyerBalance =
            await getBalance(
                env,
                buyer.address
            );


        const sellerBalance =
            await getBalance(
                env,
                seller.address
            );


        if (
            buyerBalance.chf < cost ||
            sellerBalance.toast < amount
        ) {

            await env.DB
                .prepare(`
                    UPDATE orders
                    SET status = 'cancelled'
                    WHERE id = ?
                `)
                .bind(match.id)
                .run();

            continue;
        }


        await env.DB.batch([

            // Buyer
            env.DB
                .prepare(`
                    UPDATE balances
                    SET
                        chf = chf - ?,
                        toast = toast + ?
                    WHERE address = ?
                `)
                .bind(
                    cost,
                    amount,
                    buyer.address
                ),

            // Seller
            env.DB
                .prepare(`
                    UPDATE balances
                    SET
                        toast = toast - ?,
                        chf = chf + ?
                    WHERE address = ?
                `)
                .bind(
                    amount,
                    cost,
                    seller.address
                ),

            // Current order
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

            // Matched order
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

            // Trade
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
                    timestamp()
                ),

            // Price history
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
                    timestamp()
                )

        ]);


        order.remaining -= amount;

    }
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


            // ------------------------------------------
            // HOME
            // ------------------------------------------

            if (url.pathname === "/") {

                return response({
                    name: "ToastCoin Exchange",
                    symbol: "TOAST",
                    status: "online",
                    message: "Proof of Toast"
                });

            }


            // ------------------------------------------
            // MARKET
            // ------------------------------------------

            if (
                url.pathname === "/api/market"
                && request.method === "GET"
            ) {

                return response(
                    await market(env)
                );

            }


            // ------------------------------------------
            // HISTORY
            // ------------------------------------------

            if (
                url.pathname === "/api/history"
                && request.method === "GET"
            ) {

                const range =
                    url.searchParams.get("range")
                    || "1D";


                return response({
                    range,
                    data:
                        await history(
                            env,
                            range
                        )
                });

            }


            // ------------------------------------------
            // ORDER BOOK
            // ------------------------------------------

            if (
                url.pathname === "/api/orderbook"
                && request.method === "GET"
            ) {

                return response(
                    await orderBook(env)
                );

            }


            // ------------------------------------------
            // TRADES
            // ------------------------------------------

            if (
                url.pathname === "/api/trades"
                && request.method === "GET"
            ) {

                return response({
                    trades:
                        await recentTrades(env)
                });

            }


            // ------------------------------------------
            // BALANCE
            // ------------------------------------------

            if (
                url.pathname === "/api/balance"
                && request.method === "GET"
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


            // ------------------------------------------
            // PLACE ORDER
            // ------------------------------------------

            if (
                url.pathname === "/api/order"
                && request.method === "POST"
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