import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginUserDto } from './dtos';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';

import * as bcrypt from 'bcrypt';
import { IJwtPayload, IUserRequest } from 'src/common/interfaces';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { AuthSession } from './entities';
import { Repository } from 'typeorm';
import { IAuthTokens } from './types';
import { Response } from 'express';
import { CreateUserDto } from '../user/dtos';

// TODO: set cookie and add isMobile flag to request body to adjust response based on request device
@Injectable()
export class AuthService {
  private generateTokens: (payload: IJwtPayload) => IAuthTokens;

  constructor(
    @InjectRepository(AuthSession)
    private readonly authSessionRepository: Repository<AuthSession>,
    private readonly usersService: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.generateTokens = (payload) => {
      const accessToken = this.jwtService.sign(payload, {
        secret: this.configService.get<string>('accessTokenSecret'),
        expiresIn: this.configService.get<string>('accessTokenTtl'),
      });

      const refreshToken = this.jwtService.sign(payload, {
        secret: this.configService.get<string>('refreshTokenSecret'),
        expiresIn: this.configService.get<string>('refreshTokenTtl'),
      });

      const { exp: accessExp } = this.jwtService.decode(accessToken) as {
        exp: number;
      };
      const { exp: refreshExp } = this.jwtService.decode(refreshToken) as {
        exp: number;
      };

      return {
        accessToken,
        refreshToken,
        accessTokenExpiresAt: new Date(accessExp * 1000),
        refreshTokenExpiresAt: new Date(refreshExp * 1000),
      };
    };
  }

  async register(createUserDto: CreateUserDto) {
    let encryptedPassword = await bcrypt.hash(createUserDto.password, 10);
    const user = await this.usersService.create({
      ...createUserDto,
      password: encryptedPassword,
    });

    const payload = { userId: user.id, email: user.email };

    const {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    } = this.generateTokens(payload);

    await this.authSessionRepository.save({
      refreshToken,
      expiresAt: refreshTokenExpiresAt,
      userId: user.id,
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    };
  }

  async login(loginUserDto: LoginUserDto) {
    const user = await this.usersService.findOneByEmail(loginUserDto.email);

    const isPasswordValid = await bcrypt.compare(
      loginUserDto.password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const payload = { userId: user.id, email: user.email };

    const {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    } = this.generateTokens(payload);

    await this.authSessionRepository.save({
      refreshToken,
      expiresAt: refreshTokenExpiresAt,
      userId: user.id,
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    };
  }

  async refresh(userId: string, oldRefreshToken: string) {
    const user = await this.usersService.findOneByEmail(userId);

    let authSession = await this.authSessionRepository.findOne({
      where: { refreshToken: oldRefreshToken, deleted: false },
    });

    if (!authSession) {
      throw new UnauthorizedException('No active session found.');
    }

    if (authSession.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired.');
    }

    const payload = { userId: user.id, email: user.email };

    const {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    } = this.generateTokens(payload);

    try {
      authSession.deleted = true;
      await this.authSessionRepository.save(authSession);

      await this.authSessionRepository.save({
        refreshToken,
        expiresAt: refreshTokenExpiresAt,
        userId: user.id,
      });

      return {
        accessToken,
        refreshToken,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
      };
    } catch (error: any) {
      console.error('Error during refresh:', error);
      throw new BadRequestException('Failed to refresh tokens.');
    }
  }
}
