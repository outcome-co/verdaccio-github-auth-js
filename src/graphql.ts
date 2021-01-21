import { graphql } from '@octokit/graphql'
import { withRateLimiting } from './rateLimiting'
import { RateLimiter } from 'limiter'
import { Logger } from '@verdaccio/types'
import { DocumentNode } from 'graphql'
import { PageInfo } from './schemaTypes'

type Result = Record<string, unknown>

type EmptyQueryParams = Record<string, never>
type QueryParams = Record<string, unknown>

type PageParams = {
    first: number | null
    after: string | null
}

type PaginatedQueryParams = QueryParams & Partial<PageParams>

export type PageInfoExtractor<T extends Result> = (page: T) => Pick<PageInfo, 'endCursor' | 'hasNextPage'> | undefined
export class GraphQLClient {
    // graphql is actually a function
    client: typeof graphql
    logger: Logger
    ratedLimitedExecute: <T>(fn: () => Promise<T>) => Promise<T>

    /**
     * Creates the GraphQL client.
     *
     * @param token - The Github token.
     * @param logger - A logger object.
     * @param rateLimiter - A rate limiter.
     */
    constructor(token: string, logger: Logger, rateLimiter?: RateLimiter) {
        this.client = graphql.defaults({
            headers: {
                authorization: `token ${token}`
            }
        })

        /* istanbul ignore next */
        if (rateLimiter) {
            this.ratedLimitedExecute = fn => withRateLimiting(rateLimiter, fn)
            /* istanbul ignore else */
        } else {
            this.ratedLimitedExecute = fn => fn()
        }

        this.logger = logger
    }

    /**
     * Execute a GraphQL query provided in object format.
     *
     * @param query - The query to execute.
     * @param params - The query parameters.
     * @returns A Promise on the result.
     *
     * See https://github.com/dupski/json-to-graphql-query.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    get<T extends Result, Q extends EmptyQueryParams>(query: DocumentNode): Promise<T>
    get<T extends Result, Q extends QueryParams>(query: DocumentNode, params: Q): Promise<T>
    get<T extends Result, Q extends QueryParams>(query: DocumentNode, params?: Q): Promise<T> {
        return this.ratedLimitedExecute(() => {
            /* istanbul ignore next */
            const queryStr = query.loc?.source.body
            this.logger.trace({ queryStr }, 'graphql: executing query @{queryStr}')

            return this.client<T>({ query: queryStr, ...params })
                .then(response => {
                    this.logger.trace({ response }, 'graphql: response @{response}')
                    return response
                })
                .catch(err => {
                    throw err
                })
        })
    }

    /**
     * Retrieve all pages for a given query and pagination node.
     * The query must follow the Relay edge/node convention.
     *
     * @param query - The query to execute.
     * @param params - The query params.
     * @param pageInfo - How to extract page info.
     * @returns A Promise of the result.
     *
     * See https://github.com/dupski/json-to-graphql-query.
     */
    getAll<T extends Result, Q extends PaginatedQueryParams>(
        query: DocumentNode,
        params: Q,
        pageInfo: PageInfoExtractor<T>
    ): Promise<T[]> {
        // Run the query passing the result to the recursive paginator
        const paramsWithDefault: Q = { first: 20, ...params }
        return this.get<T, Q>(query, paramsWithDefault).then(page =>
            this._getNextPage<T, Q>(page, query, paramsWithDefault, pageInfo)
        )
    }

    /**
     * Recursively paginates over a relay edge/node-style GraphQL query.
     *
     * @param page - The current page of results.
     * @param query - The query used to fetch the page.
     * @param params - The query params.
     * @param pageInfoExtractor - How to extract page info.
     * @param accumulator - The accumulated results across pages.
     * @returns A Promise of the result.
     */
    private _getNextPage<T extends Result, Q extends PaginatedQueryParams>(
        page: T,
        query: DocumentNode,
        params: Q,
        pageInfoExtractor: PageInfoExtractor<T>,
        accumulator?: T[]
    ): Promise<T[]> {
        if (!accumulator) {
            accumulator = []
        }

        accumulator.push(page)

        const pageInfo = pageInfoExtractor(page)

        // If we have more results, return a Promise
        // it will be chained to the next `then`
        if (pageInfo && pageInfo.hasNextPage) {
            return this.get<T, Q>(query, { ...params, after: pageInfo.endCursor }).then(nextPage =>
                this._getNextPage<T, Q>(nextPage, query, params, pageInfoExtractor, accumulator)
            )

            // Else, return the accumulator
        } else {
            return Promise.resolve(accumulator)
        }
    }
}
