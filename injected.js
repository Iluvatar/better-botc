"use strict";

(function() {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch(...args);
        const clonedResponse = response.clone();

        if (args[0].includes("/backend/sessions")) {
            let data = await clonedResponse.json()
            window.postMessage({ type: "USER_DATA", data: data }, "*");
            data.forEach(session => reshapeSession(session))
            return new Response(JSON.stringify(data), response);
        }
        return response;
    };
})();

function reshapeSession(session) {
    session.usersAll.forEach(user => user.username = user.id);
}
