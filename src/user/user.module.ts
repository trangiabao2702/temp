import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { AtStrategy } from 'src/auth/strategies';

@Module({
  imports: [JwtModule.register({})],
  controllers: [UserController],
  providers: [UserService, AtStrategy],
})
export class UserModule {}
