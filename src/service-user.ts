import { UserBase, UserType } from './user-base'

export class ServiceUser extends UserBase {
  public readonly name: string

  constructor(name: string) {
    super()
    this.name = name
  }

  get userType(): UserType {
    return 'service'
  }
}
