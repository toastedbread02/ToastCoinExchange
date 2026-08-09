export default {
    async fetch(request, env) {
        return new Response(
            JSON.stringify({
                name: "ToastCoin Exchange",
                symbol: "TOAST",
                status: "online",
                message: "Proof of Toast 🍞"
            }),
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
    }
};