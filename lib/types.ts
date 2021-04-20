import { OpenAPI, OpenAPIV2, OpenAPIV3 } from "openapi-types";

export function isOpenAPIV2(
    obj: OpenAPI.Document & { openapi?: string }
): obj is OpenAPIV2.Document {
    return obj.openapi === void 0;
}

export function isOpenAPIV3(
    obj: OpenAPI.Document & { openapi?: string }
): obj is OpenAPIV3.Document {
    return obj.openapi !== void 0;
}

export type Api = OpenAPI.Document & {
    host?: string;
    basePath?: string;
    consumes?: any;
};
