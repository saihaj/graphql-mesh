import { SchemaComposer } from 'graphql-compose';
import { Logger, MeshPubSub } from '@graphql-mesh/types';
import { JSONSchemaOperationConfig } from './types';
import { getOperationMetadata, isPubSubOperationConfig, isFileUpload, cleanObject } from './utils';
import { jsonFlatStringify, parseInterpolationStrings, stringInterpolator } from '@graphql-mesh/utils';
import { inspect, memoize1 } from '@graphql-tools/utils';
import urlJoin from 'url-join';
import { resolveDataByUnionInputType } from './resolveDataByUnionInputType';
import { stringify as qsStringify, parse as qsParse } from 'qs';
import {
  getNamedType,
  GraphQLError,
  GraphQLOutputType,
  isListType,
  isNonNullType,
  isScalarType,
  isUnionType,
} from 'graphql';
import _ from 'lodash';

export interface AddExecutionLogicToComposerOptions {
  baseUrl: string;
  operations: JSONSchemaOperationConfig[];
  operationHeaders?: Record<string, string>;
  fetch: WindowOrWorkerGlobalScope['fetch'];
  logger: Logger;
  pubsub?: MeshPubSub;
}

const isListTypeOrNonNullListType = memoize1(function isListTypeOrNonNullListType(type: GraphQLOutputType) {
  if (isNonNullType(type)) {
    return isListType(type.ofType);
  }
  return isListType(type);
});

function createError(message: string, extensions?: any) {
  return new GraphQLError(message, undefined, undefined, undefined, undefined, undefined, extensions);
}

export async function addExecutionLogicToComposer(
  schemaComposer: SchemaComposer,
  {
    fetch: globalFetch,
    logger,
    operations,
    operationHeaders,
    baseUrl,
    pubsub: globalPubsub,
  }: AddExecutionLogicToComposerOptions
) {
  logger.debug(() => `Attaching execution logic to the schema`);
  for (const operationConfig of operations) {
    const { httpMethod, rootTypeName, fieldName } = getOperationMetadata(operationConfig);
    const operationLogger = logger.child(`${rootTypeName}.${fieldName}`);

    const interpolationStrings: string[] = [...Object.values(operationHeaders || {}), baseUrl];

    const rootTypeComposer = schemaComposer[rootTypeName];

    const field = rootTypeComposer.getField(fieldName);

    if (isPubSubOperationConfig(operationConfig)) {
      field.description = operationConfig.description || `PubSub Topic: ${operationConfig.pubsubTopic}`;
      field.subscribe = (root, args, context, info) => {
        const pubsub = context?.pubsub || globalPubsub;
        if (!pubsub) {
          return new GraphQLError(`You should have PubSub defined in either the config or the context!`);
        }
        const interpolationData = { root, args, context, info, env: process.env };
        const pubsubTopic = stringInterpolator.parse(operationConfig.pubsubTopic, interpolationData);
        operationLogger.debug(() => `=> Subscribing to pubSubTopic: ${pubsubTopic}`);
        return pubsub.asyncIterator(pubsubTopic);
      };
      field.resolve = root => {
        operationLogger.debug(() => `Received ${inspect(root)} from ${operationConfig.pubsubTopic}`);
        return root;
      };
      interpolationStrings.push(operationConfig.pubsubTopic);
    } else if (operationConfig.path) {
      if (process.env.DEBUG) {
        field.description = `
    Original Description: ${operationConfig.description || '(none)'}
    Method: ${operationConfig.method}
    baseUrl: ${baseUrl}
    Path: ${operationConfig.path}
`;
      } else {
        field.description = operationConfig.description;
      }
      field.resolve = async (root, args, context) => {
        operationLogger.debug(() => `=> Resolving`);
        const interpolationData = { root, args, context, env: process.env };
        const interpolatedBaseUrl = stringInterpolator.parse(baseUrl, interpolationData);
        const interpolatedPath = stringInterpolator.parse(operationConfig.path, interpolationData);
        let fullPath = urlJoin(interpolatedBaseUrl, interpolatedPath);
        const headers = {
          ...operationHeaders,
          ...operationConfig?.headers,
        };
        for (const headerName in headers) {
          headers[headerName] = stringInterpolator.parse(headers[headerName], interpolationData);
        }
        const requestInit: RequestInit = {
          method: httpMethod,
          headers,
        };
        // Handle binary data
        if ('binary' in operationConfig) {
          const binaryUpload = await args.input;
          if (isFileUpload(binaryUpload)) {
            const readable = binaryUpload.createReadStream();
            const chunks: number[] = [];
            for await (const chunk of readable) {
              for (const byte of chunk) {
                chunks.push(byte);
              }
            }
            requestInit.body = new Uint8Array(chunks);

            const [, contentType] = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type') || [];
            if (!contentType) {
              headers['content-type'] = binaryUpload.mimetype;
            }
          }
          requestInit.body = binaryUpload;
        } else {
          if (operationConfig.requestBaseBody != null) {
            args.input = args.input || {};
            for (const key in operationConfig.requestBaseBody) {
              const configValue = operationConfig.requestBaseBody[key];
              if (typeof configValue === 'string') {
                const value = stringInterpolator.parse(configValue, interpolationData);
                _.set(args.input, key, value);
              } else {
                args.input[key] = configValue;
              }
            }
          }
          // Resolve union input
          const input = resolveDataByUnionInputType(
            cleanObject(args.input),
            field.args?.input?.type?.getType(),
            schemaComposer
          );
          if (input != null) {
            switch (httpMethod) {
              case 'GET':
              case 'HEAD':
              case 'CONNECT':
              case 'OPTIONS':
              case 'TRACE': {
                fullPath += fullPath.includes('?') ? '&' : '?';
                fullPath += qsStringify(input);
                break;
              }
              case 'POST':
              case 'PUT':
              case 'PATCH':
              case 'DELETE': {
                const [, contentType] =
                  Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type') || [];
                if (contentType?.startsWith('application/x-www-form-urlencoded')) {
                  requestInit.body = qsStringify(input);
                } else {
                  requestInit.body = jsonFlatStringify(input);
                }
                break;
              }
              default:
                return createError(`Unknown HTTP Method: ${httpMethod}`, {
                  url: fullPath,
                  method: httpMethod,
                });
            }
          }
        }

        // Delete unused queryparams
        const [actualPath, queryString] = fullPath.split('?');
        if (queryString) {
          const queryParams = qsParse(queryString);
          const cleanedQueryParams = cleanObject(queryParams);
          fullPath = actualPath + '?' + qsStringify(cleanedQueryParams);
        }

        operationLogger.debug(() => `=> Fetching ${fullPath}=>${inspect(requestInit)}`);
        const fetch: typeof globalFetch = context?.fetch || globalFetch;
        if (!fetch) {
          return createError(`You should have fetch defined in either the config or the context!`, {
            url: fullPath,
            method: httpMethod,
          });
        }
        const response = await fetch(fullPath, requestInit);
        const responseText = await response.text();
        operationLogger.debug(
          () =>
            `=> Received ${inspect({
              headers: response.headers,
              text: responseText,
            })}`
        );
        let responseJson: any;
        try {
          responseJson = JSON.parse(responseText);
        } catch (error) {
          const returnNamedGraphQLType = getNamedType(field.type.getType());
          // The result might be defined as scalar
          if (isScalarType(returnNamedGraphQLType)) {
            operationLogger.debug(() => ` => Return type is not a JSON so returning ${responseText}`);
            return responseText;
          }
          return createError(`Unexpected response`, {
            url: fullPath,
            method: httpMethod,
            responseText,
            error,
          });
        }

        if (!response.status.toString().startsWith('2')) {
          const returnNamedGraphQLType = getNamedType(field.type.getType());
          if (!isUnionType(returnNamedGraphQLType)) {
            return createError(`HTTP Error: ${response.status}`, {
              url: fullPath,
              method: httpMethod,
              ...(response.statusText ? { status: response.statusText } : {}),
              responseJson,
            });
          }
        }

        operationLogger.debug(() => `=> Returning ${inspect(responseJson)}`);
        // Sometimes API returns an array but the return type is not an array
        const isListReturnType = isListTypeOrNonNullListType(field.type.getType());
        const isArrayResponse = Array.isArray(responseJson);
        if (isListReturnType && !isArrayResponse) {
          operationLogger.debug(() => `Response is not array but return type is list. Normalizing the response`);
          responseJson = [responseJson];
        }
        if (!isListReturnType && isArrayResponse) {
          operationLogger.debug(() => `Response is array but return type is not list. Normalizing the response`);
          responseJson = responseJson[0];
        }

        const addResponseMetadata = (obj: any) => ({
          ...obj,
          __response: {
            url: fullPath,
            method: httpMethod,
            status: response.status,
            statusText: response.statusText,
          },
        });
        operationLogger.debug(() => `Adding response metadata to the response object`);
        return Array.isArray(responseJson)
          ? responseJson.map(obj => addResponseMetadata(obj))
          : addResponseMetadata(responseJson);
      };
      interpolationStrings.push(...Object.values(operationConfig.headers || {}));
      interpolationStrings.push(operationConfig.path);
    }
    const { args: globalArgs } = parseInterpolationStrings(interpolationStrings, operationConfig.argTypeMap);
    rootTypeComposer.addFieldArgs(fieldName, globalArgs);
  }

  logger.debug(() => `Building the executable schema.`);
  return schemaComposer;
}
