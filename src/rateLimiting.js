/* istanbul ignore file */

import { RateLimiter } from 'limiter'

/**
 * Perform a fn call with optional rate limiting.
 *
 * @param {RateLimiter} limiter - The rate limiter.
 * @param {Function} fn - The function to call.
 * @returns {Promise} - The return value of the function.
 */
export const withRateLimiting = (limiter, fn) => {
    return new Promise((resolve, reject) => {
        limiter.removeTokens(1, (e, remainingTokens) => {
            if (e) {
                reject(e)
            } else {
                resolve(fn())
            }
        })
    })
}
