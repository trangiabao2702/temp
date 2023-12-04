import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthDto, AccountDto } from './dto';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Tokens } from './types';
import {
  ACCOUNT_STATUS_ACTIVED,
  ACCOUNT_STATUS_PENDING,
  EMAIL_VERIFICATION_ACTIVATE_ACCOUNT,
  EMAIL_VERIFICATION_RESET_PASSWORD,
  HTTP_MSG_INTERNAL_SERVER_ERROR,
  HTTP_MSG_NOTFOUND,
  HTTP_MSG_SUCCESS,
  HTTP_MSG_UNAUTHORIZED,
} from 'src/constants';
import { MailerService } from '@nest-modules/mailer';
import { Request, Response } from 'express';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailerService: MailerService,
  ) {}

  // Hash data by bcrypt lib
  hashData(data: string) {
    return bcrypt.hash(data, 10);
  }

  // Generate a pair of tokens: access_token and refresh_token
  async getTokens(userId: number, role: string): Promise<Tokens> {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        {
          sub: userId,
          role,
        },
        {
          secret: process.env.JWT_ACCESS_TOKEN_SECRET_KEY,
          expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRE_TIME,
        },
      ),
      this.jwtService.signAsync(
        {
          sub: userId,
          role,
        },
        {
          secret: process.env.JWT_REFRESH_TOKEN_SECRET_KEY,
          expiresIn: process.env.JWT_REFRESH_TOKEN_EXPIRE_TIME,
        },
      ),
    ]);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  // Hash the refresh token and save to database
  async hashRefreshToken(userId: number, refreshToken: string) {
    const hashRefreshToken = await this.hashData(refreshToken);

    await this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        refreshToken: hashRefreshToken,
      },
    });
  }

  // [POST] /register
  async register(dto: AuthDto, res: Response) {
    try {
      // check if exist a same username/email in database
      const existedUsername = await this.prisma.account.findFirst({
        where: {
          username: dto.username,
        },
      });
      if (existedUsername != null) {
        return res
          .status(HttpStatus.FORBIDDEN)
          .send(`The username ${dto.username} existed`);
      }

      const existedEmail = await this.prisma.user.findFirst({
        where: {
          email: dto.email,
        },
      });
      if (existedEmail != null) {
        return res
          .status(HttpStatus.FORBIDDEN)
          .send(`The email ${dto.email} existed`);
      }

      // create new user in database
      const newUser = await this.prisma.user.create({
        data: {
          firstName: dto.first_name,
          lastName: dto.last_name,
          email: dto.email,
          role: dto.role,
          refreshToken: '',
        },
      });

      const hashPassword = await this.hashData(dto.password);

      // create new account
      await this.prisma.account.create({
        data: {
          userId: newUser.id,
          username: dto.username,
          password: hashPassword,
          status: ACCOUNT_STATUS_PENDING,
        },
      });

      // send email for user to activate his account (hash email and verify by email)
      const hashedId = await this.hashData(newUser.id.toString());
      await this.mailerService.sendMail({
        to: newUser.email,
        subject: 'Active your account',
        template: './activate_email',
        context: {
          verifyUrl:
            process.env.HOST_URL +
            '/auth/verify/' +
            EMAIL_VERIFICATION_ACTIVATE_ACCOUNT +
            '/' +
            newUser.id, //+
          // '/' +
          // encodeURIComponent(hashedId),
        },
      });

      return res.status(HttpStatus.OK).send(HTTP_MSG_SUCCESS);
    } catch (error) {
      // If the error has a status property, set the corresponding HTTP status code
      if (error.status) {
        return res.status(error.status).send(error.message);
      }

      // If the error doesn't have a status property, set a generic 500 Internal Server Error status code
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send(HTTP_MSG_INTERNAL_SERVER_ERROR);
    }
  }

  // [POST] /login
  async login(dto: AccountDto, res: Response) {
    try {
      const account = await this.prisma.account.findUnique({
        where: {
          username: dto.username,
        },
      });
      if (!account) {
        return res.status(HttpStatus.NOT_FOUND).send(HTTP_MSG_NOTFOUND);
      }

      if (account.status != ACCOUNT_STATUS_ACTIVED) {
        return res.status(HttpStatus.FORBIDDEN).send('Account is inactived');
      }

      const user = await this.prisma.user.findUnique({
        where: {
          id: account.userId,
        },
      });

      const passwordMatches = await bcrypt.compare(
        dto.password,
        account.password,
      );
      if (!passwordMatches) {
        return res.status(HttpStatus.FORBIDDEN).send('Access Denied');
      }

      const tokens = await this.getTokens(account.userId, user.role);
      await this.hashRefreshToken(user.id, tokens.refresh_token);

      return res.status(HttpStatus.OK).send(tokens);
    } catch (error) {
      // If the error has a status property, set the corresponding HTTP status code
      if (error.status) {
        return res.status(error.status).send(error.message);
      }

      // If the error doesn't have a status property, set a generic 500 Internal Server Error status code
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send(HTTP_MSG_INTERNAL_SERVER_ERROR);
    }
  }

  // [POST] /logout
  async logout(userId: number, res: Response) {
    try {
      console.log(111);
      await this.prisma.user.update({
        where: {
          id: userId,
          refreshToken: {
            not: '',
          },
        },
        data: {
          refreshToken: '',
        },
      });

      return res.status(HttpStatus.OK).send(HTTP_MSG_SUCCESS);
    } catch (error) {
      // If the error has a status property, set the corresponding HTTP status code
      if (error.status) {
        return res.status(error.status).send(error.message);
      }

      // If the error doesn't have a status property, set a generic 500 Internal Server Error status code
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send(HTTP_MSG_INTERNAL_SERVER_ERROR);
    }
  }

  // [POST] /refresh
  async refresh(userId: number, refreshToken: string, res: Response) {
    try {
      const user = await this.prisma.user.findUnique({
        where: {
          id: userId,
        },
      });

      if (user == null) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .send(HTTP_MSG_INTERNAL_SERVER_ERROR);
      }

      const refreshTokenMatches = await bcrypt.compare(
        refreshToken,
        user.refreshToken,
      );

      if (!refreshTokenMatches) {
        return res.status(HttpStatus.UNAUTHORIZED).send(HTTP_MSG_UNAUTHORIZED);
      }

      const tokens = await this.getTokens(user.id, user.role);
      await this.hashRefreshToken(user.id, tokens.refresh_token);

      return res.status(HttpStatus.OK).send(tokens);
    } catch (error) {
      // If the error has a status property, set the corresponding HTTP status code
      if (error.status) {
        return res.status(error.status).send(error.message);
      }

      // If the error doesn't have a status property, set a generic 500 Internal Server Error status code
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send(HTTP_MSG_INTERNAL_SERVER_ERROR);
    }
  }

  // [GET] /verify/:type/:id
  async verifyEmail(type: string, id: string, res: Response) {
    try {
      console.log('[Begin] Verify Email');

      // const hashedEmail = await this.hashData(id);
      // const emailMatches = await bcrypt.compare(hashedEmail, token);
      // if (emailMatches) {
      //   console.log('Email matches');
      if (1) {
        const user = await this.prisma.user.findFirst({
          where: {
            id: parseInt(id),
          },
        });

        if (user == null) {
          console.log('User not found');
          return res.status(HttpStatus.NOT_FOUND).send(HTTP_MSG_NOTFOUND);
        }

        console.log('User found');

        const account = await this.prisma.account.findFirst({
          where: {
            userId: parseInt(id),
          },
        });

        switch (type) {
          case EMAIL_VERIFICATION_ACTIVATE_ACCOUNT: {
            console.log('Activate Account');

            if (account.status == ACCOUNT_STATUS_PENDING) {
              return res
                .status(HttpStatus.UNAUTHORIZED)
                .send(HTTP_MSG_UNAUTHORIZED);
            }

            await this.prisma.account.update({
              where: {
                userId: user.id,
              },
              data: {
                status: ACCOUNT_STATUS_ACTIVED,
              },
            });
            console.log("Updated account's status");

            return res.redirect(process.env.CLIENT_HOME_PAGE);
          }
          case EMAIL_VERIFICATION_RESET_PASSWORD: {
            console.log('Reset Password');

            const hashedId = await this.hashData(user.id.toString());

            return res.redirect(
              process.env.CLIENT_RESET_PASSWORD_PAGE + '/' + user.id.toString(), // +
              // '/' +
              // hashedId,
            );
          }
          default: {
            return res.redirect(process.env.CLIENT_HOME_PAGE);
          }
        }
      }

      console.log('[End] Verify Email');
    } catch (error) {
      // If the error has a status property, set the corresponding HTTP status code
      if (error.status) {
        return res.status(error.status).send(error.message);
      }

      // If the error doesn't have a status property, set a generic 500 Internal Server Error status code
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send(HTTP_MSG_INTERNAL_SERVER_ERROR);
    }
  }

  // [POST] /forgot_password
  async forgotPassword(email: string, res: Response) {
    try {
      // need refactor
      const user = await this.prisma.user.findFirst({
        where: {
          email: email,
        },
      });

      const hashedEmail = await this.hashData(email);
      await this.mailerService.sendMail({
        to: email,
        subject: 'Reset your password',
        template: './reset_password',
        context: {
          verifyUrl:
            process.env.HOST_URL +
            '/auth/verify/' +
            EMAIL_VERIFICATION_RESET_PASSWORD +
            '/' +
            user.id, //+
          // '/' +
          // hashedEmail,
        },
      });

      return res.status(HttpStatus.OK).send(HTTP_MSG_SUCCESS);
    } catch (error) {
      // If the error has a status property, set the corresponding HTTP status code
      if (error.status) {
        return res.status(error.status).send(error.message);
      }

      // If the error doesn't have a status property, set a generic 500 Internal Server Error status code
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send(HTTP_MSG_INTERNAL_SERVER_ERROR);
    }
  }

  // [POST] /reset_password
  async resetPassword(
    userId: string,
    new_password: string,
    // token: string,
    res: Response,
  ) {
    try {
      const user = await this.prisma.user.findUnique({
        where: {
          id: parseInt(userId),
        },
      });

      if (user == null) {
        return res.status(HttpStatus.NOT_FOUND).send(HTTP_MSG_NOTFOUND);
      }

      // const idMatches = await bcrypt.compare(user.id, token);
      // if (!idMatches) {
      //   return res.status(HttpStatus.UNAUTHORIZED).send(HTTP_MSG_UNAUTHORIZED);
      // }

      const newPassword = await this.hashData(new_password);
      await this.prisma.account.update({
        where: {
          userId: user.id,
        },
        data: {
          password: newPassword,
        },
      });

      return res.status(HttpStatus.OK).send(HTTP_MSG_SUCCESS);
    } catch (error) {
      // If the error has a status property, set the corresponding HTTP status code
      if (error.status) {
        return res.status(error.status).send(error.message);
      }

      // If the error doesn't have a status property, set a generic 500 Internal Server Error status code
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send(HTTP_MSG_INTERNAL_SERVER_ERROR);
    }
  }
}
