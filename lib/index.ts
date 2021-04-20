"use strict";

import Package from "../package.json";
import Joi from "@hapi/joi";
import Hoek from "@hapi/hoek";
import Caller from "./caller";
import Path from "path";
import SwaggerParser from "@apidevtools/swagger-parser";
import Utils from "./utils";
import Routes from "./routes";
import Yaml from "js-yaml";
import Fs from "fs";
import Util from "util";
import type { OpenAPIV2, OpenAPIV3 } from "openapi-types";
import { OpenAPI } from "openapi-types";
import { Plugin, PluginBase, Server } from "@hapi/hapi";
import { Api, isOpenAPIV2, isOpenAPIV3 } from "./types";

const CALLER_DIR = Path.resolve(Path.dirname(Caller()));

const optionsSchema = Joi.object({
    api: Joi.alternatives(Joi.string(), Joi.object().unknown(true)),
    //deprecated
    docspath: Joi.string().default("/api-docs"),
    docs: Joi.object({
        path: Joi.string().default("/api-docs"),
        auth: Joi.alternatives().try(Joi.object(), Joi.boolean()).allow(null),
        stripExtensions: Joi.boolean().default(true),
        prefixBasePath: Joi.boolean().default(true),
    }).default(),
    cors: Joi.alternatives().try(Joi.object(), Joi.boolean()).default(true),
    vhost: Joi.string().allow(null),
    handlers: Joi.alternatives()
        .try(
            Joi.string().default(Path.join(CALLER_DIR, "routes")),
            Joi.object()
        )
        .allow(null),
    extensions: Joi.array().items(Joi.string()).default(["js"]),
    outputvalidation: Joi.boolean().default(false),
}).required();

const stripVendorExtensions = function (obj: any) {
    if (Util.isArray(obj)) {
        const clean: any[] = [];
        for (const value of obj) {
            clean.push(stripVendorExtensions(value));
        }
        return clean;
    }
    if (Util.isObject(obj)) {
        const clean = {};
        for (const [key, value] of Object.entries(obj)) {
            if (!key.match(/x-(.*)/)) {
                clean[key] = stripVendorExtensions(value);
            }
        }
        return clean;
    }
    return obj;
};

const requireApi = function (path) {
    let document;

    if (path.match(/\.ya?ml?/)) {
        const file = Fs.readFileSync(path);
        document = Yaml.load(file);
    } else {
        document = require(path);
    }

    return document;
};

const register = async (server: Server, options: any) => {
    const validation = optionsSchema.validate(options);

    Hoek.assert(!validation.error, validation.error);

    const {
        api,
        cors,
        vhost,
        handlers,
        extensions,
        outputvalidation,
    } = validation.value;
    let { docs, docspath } = validation.value;
    const spec: Api = await SwaggerParser.validate(api);

    // Cannot use conflicting url pathnames, so opting to mount the first url pathname
    if (isOpenAPIV3(spec)) {
        spec.basePath = new URL(
            Hoek.reach(spec, ["servers", 0, "url"])
        ).pathname;
    }
    spec.basePath = Utils.unsuffix(
        Utils.prefix(spec.basePath || "/", "/"),
        "/"
    );

    //Expose plugin api
    server.expose({
        getApi() {
            return spec;
        },
        setHost: function setHost(host) {
            spec.host = host;
        },
    });

    let basedir;
    let apiDocument;

    if (Util.isString(api)) {
        apiDocument = requireApi(api);
        basedir = Path.dirname(Path.resolve(api));
    } else {
        apiDocument = api;
        basedir = CALLER_DIR;
    }

    if (spec["x-hapi-auth-schemes"]) {
        for (const [name, path] of Object.entries(
            spec["x-hapi-auth-schemes"]
        )) {
            const scheme = require(Path.resolve(
                Path.join(basedir, path as any)
            ));
            await server.register({
                plugin: scheme,
                options: {
                    name,
                },
            });
        }
    }

    let securitySchemes:
        | OpenAPIV2.SecurityDefinitionsObject
        | {
              [key: string]:
                  | OpenAPIV3.ReferenceObject
                  | OpenAPIV3.SecuritySchemeObject;
          }
        | void;
    if (isOpenAPIV2(spec) && spec.securityDefinitions) {
        securitySchemes = spec.securityDefinitions;
    }
    if (
        isOpenAPIV3(spec) &&
        spec.components &&
        spec.components.securitySchemes
    ) {
        securitySchemes = spec.components.securitySchemes;
    }

    if (securitySchemes) {
        for (const [name, security] of Object.entries(securitySchemes)) {
            if (security["x-hapi-auth-strategy"]) {
                const strategy = require(Path.resolve(
                    Path.join(basedir, security["x-hapi-auth-strategy"])
                ));
                await server.register({
                    plugin: strategy,
                    options: {
                        name,
                        scheme: security.type,
                        lookup: security.name,
                        where: security.in,
                    },
                });
            }
        }
    }
    console.log("PPP");
    if (docspath !== "/api-docs" && docs.path === "/api-docs") {
        server.log(["warn"], "docspath is deprecated. Use docs instead.");
        docs = {
            path: docspath,
            prefixBasePath: docs.prefixBasePath,
        };
    }

    let apiPath = docs.path;
    if (docs.prefixBasePath) {
        docs.path = Utils.prefix(docs.path, "/");
        docs.path = Utils.unsuffix(docs.path, "/");
        apiPath = spec.basePath + docs.path;
    }

    if (docs.stripExtensions) {
        apiDocument = stripVendorExtensions(apiDocument);
    }

    //API docs route
    server.route({
        method: "GET",
        path: apiPath,
        options: {
            handler(request, h) {
                return apiDocument;
            },
            cors,
            id: `${apiPath.replace(/\//g, "_")}`,
            description: "The OpenAPI document.",
            tags: ["api", "documentation"],
            auth: docs.auth,
        },
        vhost,
    });

    const routes = await Routes.create(server, {
        api: spec,
        basedir,
        cors,
        vhost,
        handlers,
        extensions,
        outputvalidation,
    });

    for (const route of routes) {
        server.route(route);
    }
};

const SwaggerizeHapi: Plugin<any> = {
    register,
    name: "openapi",
    version: Package.version,
    multiple: true,
};
export default SwaggerizeHapi;
