export default {
    async fetch(request, env) {

        try {

            if (!env.DB) {
                return new Response(
                    "DB binding is missing",
                    { status: 500 }
                );
            }

            const result = await env.DB
                .prepare("SELECT 1 AS toast")
                .first();

            return new Response(
                JSON.stringify({
                    success: true,
                    database: result
                }),
                {
                    headers: {
                        "Content-Type": "application/json"
                    }
                }
            );

        } catch (error) {

            return new Response(
                JSON.stringify({
                    success: false,
                    error: error.message,
                    stack: error.stack
                }),
                {
                    status: 500,
                    headers: {
                        "Content-Type": "application/json"
                    }
                }
            );

        }
    }
};