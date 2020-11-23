const { graphql } = require('@octokit/graphql')
const { jsonToGraphQLQuery, EnumType } = require('json-to-graphql-query')
const { get, set, concat, extend, cloneDeep } = require('lodash')
const { withRateLimiting } = require('./rateLimiting')

export const enumValue = v => new EnumType(v)

/**
 * @typedef {import('@verdaccio/types').Logger} Logger
 * @typedef {import('limiter').RateLimiter} RateLimiter
 */

export default class {
    /**
     * Creates the GraphQL client.
     *
     * @param {string} token - The Github token.
     * @param {Logger} logger - A logger object.
     * @param {RateLimiter} [rateLimiter] - A rate limiter.
     */
    constructor (token, logger, rateLimiter) {
        this.client = graphql.defaults({
            headers: {
                authorization: `token ${token}`
            }
        })

        /* istanbul ignore next */
        if (rateLimiter) {
            this.ratedLimitedExecute = (fn) => withRateLimiting(rateLimiter, fn)
        /* istanbul ignore else */
        } else {
            this.ratedLimitedExecute = (fn) => fn()
        }

        this.logger = logger
    }

    /**
     * Execute a GraphQL query provided in object format.
     *
     * @param {object} queryObj - The query to execute.
     * @returns {Promise<object>} A Promise on the result.
     *
     * See https://github.com/dupski/json-to-graphql-query.
     */
    execute (queryObj) {
        return this.ratedLimitedExecute(() => {
            const queryStr = jsonToGraphQLQuery({ query: queryObj })

            this.logger.trace({ queryStr }, 'graphql: executing query @{queryStr}')

            return this.client({ query: queryStr }).then((response) => {
                this.logger.trace({ response }, 'graphql: response @{response}')
                return response
            }).catch((err) => {
                throw err
            })
        })
    }

    /**
     * Alias for `execute`.
     *
     * @param {object} queryObj - The query to execute.
     * @returns {Promise<object>} A Promise on the result.
     *
     * See https://github.com/dupski/json-to-graphql-query.
     */
    get (queryObj) {
        return this.execute(queryObj)
    }

    /**
     * Retrieve all pages for a given query and pagination node.
     * The query must follow the Relay edge/node convention.
     *
     * @param {object} queryObj - The query to execute.
     * @param {string} path - The path to the node which will be paginated.
     * @returns {Promise<object>} A Promise of the result.
     *
     * See https://github.com/dupski/json-to-graphql-query.
     */
    getAll (queryObj, path) {
        // Make a copy so we don't modify the original
        queryObj = cloneDeep(queryObj)

        // Get the part of the query that will use pagination
        const pageOnQuery = get(queryObj, path)

        // Ensure we have the basic objects for page information and parameters
        pageOnQuery.pageInfo = pageOnQuery.pageInfo || {}
        pageOnQuery.__args = pageOnQuery.__args || {}

        // Add the required page info to the query
        extend(pageOnQuery.pageInfo, {
            hasNextPage: {},
            endCursor: {}
        })

        // Set a default page size
        pageOnQuery.__args.first = pageOnQuery.__args.first || 20

        // Run the query passing the result to the recursive paginator
        return this.execute(queryObj).then(page => this._getNextPage(page, queryObj, path))
    }

    /**
     * Recursively paginates over a relay edge/node-style GraphQL query.
     *
     * @param {object} page - The current page of results.
     * @param {object} queryObj - The query used to fetch the page.
     * @param {string} path - The path to the node which will be paginated.
     * @param {object} [accumulator] - The accumulated results across pages.
     * @returns {Promise<object>} A Promise of the result.
     */
    _getNextPage (page, queryObj, path, accumulator) {
        const pageOnResult = get(page, path)

        // If we already have results, merge the new results into the accumulator
        if (accumulator) {
            const edgesPath = `${path}.edges`
            set(accumulator, edgesPath, concat(get(accumulator, edgesPath), get(page, edgesPath)))

        // Else, set the page to be the accumulator
        } else {
            accumulator = page
        }

        // If we have more results, return a Promise
        // it will be chained to the next `then`
        if (pageOnResult.pageInfo.hasNextPage) {
            const pageOnQuery = get(queryObj, path)
            pageOnQuery.__args.after = pageOnResult.pageInfo.endCursor

            return this.execute(queryObj).then(page => this._getNextPage(page, queryObj, path, accumulator))

        // Else, return the accumulator
        } else {
            return accumulator
        }
    }
}
