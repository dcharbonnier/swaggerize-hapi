"use strict";

import Store from "../lib/store";

module.exports = {
    get: function (req, h) {
        return Store.all();
    },
    post: function (req, h) {
        return Store.get(Store.put(req.payload));
    },
};
