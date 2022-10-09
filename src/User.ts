import { JwtPayload } from './context'
import { compact } from './utils'

export class User {
  public readonly token: string
  public readonly claims: JwtPayload

  constructor(claims: JwtPayload, accessToken: string) {
    this.claims = claims
    this.token = accessToken
  }

  get email(): string {
    return (
      this.claims.email ??
      (this.claims.emails as string[] | undefined)?.[0] ??
      this.claims.preferred_username ??
      this.claims.unique_name ??
      this.claims.upn ??
      ''
    )
  }

  get name(): string {
    return this.claims.name ?? compact(this.claims.given_name, this.claims.family_name).join(' ') ?? ''
  }

  get firstName(): string {
    return this.claims.given_name ?? ''
  }

  get lastName(): string {
    return this.claims.family_name ?? ''
  }

  get oid(): string {
    return this.claims.oid ?? ''
  }

  get scopes(): string[] {
    return this.claims.scp ? this.claims.scp.split(' ') : []
  }

  get roles(): string[] {
    return this.claims.roles ?? []
  }
}
