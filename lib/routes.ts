"use strict";

import ObjectFiles from "merge-object-files";
import Validators from "./validators";
import Hoek from "@hapi/hoek";
import Utils from "./utils";
import Path from "path";
import Props from "dot-prop";
import {
    RequestRoute,
    RouteSettings,
    Server,
    AuthSettings,
    ServerRoute,
    RouteOptions,
    RouteOptionsAccess,
    RouteOptionsAccessObject,
    RouteOptionsAccessScopeObject,
} from "@hapi/hapi";
import { OpenAPI, OpenAPIV2 } from "openapi-types";
import { Api, isOpenAPIV2, isOpenAPIV3 } from "./types";

const create = async function (
    server: Server,
    {
        api,
        basedir,
        cors,
        vhost,
        handlers,
        extensions,
        outputvalidation,
    }: {
        api: Api;
        basedir: string;
        cors: string;
        vhost: string;
        handlers: any;
        extensions: any[];
        outputvalidation: any[];
    }
) {
    const routes: ServerRoute[] = [];
    const validator = Validators.create({ api });

    if (typeof handlers === "string") {
        handlers = await ObjectFiles.merge(handlers, extensions);
    }
    //Support x-hapi-handler when no handlers set.
    if (!handlers) {
        for (const [path, operations] of Object.entries(api.paths)) {
            if (operations["x-hapi-handler"]) {
                const pathnames = path.split("/").slice(1).join(".");

                if (!handlers) {
                    handlers = {};
                }

                const xhandler = require(Path.resolve(
                    Path.join(basedir, operations["x-hapi-handler"])
                ));

                Props.set(handlers, pathnames, xhandler);
            }
        }
    }

    for (const [path, operations] of Object.entries(api.paths)) {
        const pathnames = Utils.unsuffix(path, "/")
            .split("/")
            .slice(1)
            .join(".");

        for (const [method, operation] of Object.entries(
            operations
        ) as OpenAPIV2.OperationObject<any>) {
            const pathsearch = `${pathnames}.${method}`;
            const handler = Hoek.reach(handlers, pathsearch);
            const xoptions = operation["x-hapi-options"] || {};

            if (!handler) {
                continue;
            }

            const customTags = operation.tags || [];
            const options: RouteOptions & {
                auth?: RouteOptionsAccess & {
                    access: RouteOptionsAccessScopeObject & {
                        scope: string[] | false;
                    };
                };
            } = Object.assign(
                {
                    cors,
                    id: operation.operationId,
                    // hapi does not support empty descriptions
                    description:
                        operation.description !== ""
                            ? operation.description
                            : undefined,
                    tags: ["api", ...customTags],
                },
                xoptions
            );

            options.handler = handler;

            if (Utils.canCarry(method)) {
                options.payload = options.payload
                    ? Hoek.applyToDefaults(
                          { allow: operation.consumes || api.consumes },
                          options.payload
                      )
                    : { allow: operation.consumes || api.consumes };
            }

            if (Array.isArray(handler)) {
                options.pre = [];

                for (let i = 0; i < handler.length - 1; ++i) {
                    options.pre.push({
                        assign: handler[i].name || "p" + (i + 1),
                        method: handler[i],
                    });
                }
                options.handler = handler[handler.length - 1];
            }

            const skipValidation =
                options.payload && options.payload.parse === false;

            if (
                (operation.parameters || operation.requestBody) &&
                !skipValidation
            ) {
                const allowUnknownProperties =
                    xoptions.validate &&
                    xoptions.validate.options &&
                    xoptions.validate.options.allowUnknown === true;
                const v = validator.makeAll(
                    operation.parameters,
                    operation.requestBody,
                    operation.consumes || api.consumes,
                    isOpenAPIV3(api) ? api.openapi : void 0,
                    allowUnknownProperties
                );
                options.validate = v.validate;
                options.ext = {
                    onPreAuth: { method: v.routeExt as any },
                };
            }

            if (outputvalidation && operation.responses) {
                options.response = {};
                options.response.status = validator.makeResponseValidator(
                    operation.responses,
                    isOpenAPIV3(api) ? api.openapi : void 0
                );
            }

            if (operation.security === undefined && api.security) {
                operation.security = api.security;
            }

            if (operation.security && operation.security.length) {
                for (const secdef of operation.security) {
                    const securitySchemes = Object.keys(secdef);

                    for (const securityDefinitionName of securitySchemes) {
                        let securityDefinition;
                        if (isOpenAPIV2(api)) {
                            securityDefinition =
                                api.securityDefinitions?.[
                                    securityDefinitionName
                                ];
                        }
                        if (isOpenAPIV3(api)) {
                            securityDefinition =
                                api.components?.securitySchemes?.[
                                    securityDefinitionName
                                ];
                        }

                        Hoek.assert(
                            securityDefinition,
                            "Security scheme not defined."
                        );

                        options.auth = options.auth || {
                            strategies: [],
                            access: { scope: [] },
                            mode: "required",
                        };
                        options.auth.access!.scope =
                            options.auth.access!.scope || [];
                        options.auth.access!.scope.push(
                            ...secdef[securityDefinitionName]
                        );
                        options.auth.strategies = options.auth.strategies || [];
                        options.auth.strategies.push(securityDefinitionName);
                    }
                }
                if (
                    Array.isArray(options.auth!.access!.scope) &&
                    options.auth!.access!.scope.length === 0
                ) {
                    options.auth!.access!.scope = false;
                }
            }

            routes.push({
                method,
                path: api.basePath + path,
                options,
                vhost,
            });
        }
    }

    return routes;
};

export default { create };
