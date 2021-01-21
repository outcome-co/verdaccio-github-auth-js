/* istanbul ignore file */

import { RateLimiter } from 'limiter'

/**
 * Perform a fn call with optional rate limiting.
 *
 * @param limiter - The rate limiter.
 * @param fn - The function to call.
 * @returns The return value of the function.
 */
export const withRateLimiting = <T>(limiter: RateLimiter, fn: () => Promise<T>): Promise<T> => {
    return new Promise((resolve, reject) => {
        limiter.removeTokens(1, (e: string) => {
            if (e) {
                reject(e)
            } else {
                resolve(fn())
            }
        })
    })
}
