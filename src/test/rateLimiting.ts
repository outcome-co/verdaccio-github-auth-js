/* istanbul ignore file */

import { withRateLimiting as _withRateLimiting } from '../rateLimiting'
import { RateLimiter } from 'limiter'
import { insideGithubActions } from './env'

const limiter: RateLimiter = new RateLimiter(2, 'second')
let rateLimitingWrapper: <T>(fn: () => Promise<T>) => Promise<T>

/* eslint-disable no-console */
if (insideGithubActions) {
    console.log('Using rate limiting')
    rateLimitingWrapper = <T>(fn: () => Promise<T>): Promise<T> => _withRateLimiting<T>(limiter, fn)
} else {
    console.log('Not using rate limiting')
    rateLimitingWrapper = <T>(fn: () => Promise<T>): Promise<T> => fn()
}
/* eslint-enable no-console */

export const withRateLimiting = rateLimitingWrapper
export const rateLimiter = limiter
