export type Claims = Record<string, string | undefined> & {
  roles: string[] | undefined
}

export class User {
  public readonly token: string
  public readonly claims: Claims

  constructor(claims: Claims, accessToken: string) {
    this.claims = claims
    this.token = accessToken
  }

  get email(): string {
    return this.claims.email ?? this.claims.preferred_username ?? this.claims.unique_name ?? this.claims.upn ?? ''
  }

  get name(): string {
    return this.claims.name ?? ''
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
